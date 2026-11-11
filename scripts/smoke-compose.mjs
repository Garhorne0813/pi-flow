// Isolated, disposable Compose project: exercise every migration from an empty
// volume, then run a personal task through the production image's demo mode.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
const project = "piflow-smoke-" + randomBytes(6).toString("hex");
const folder = resolve("work", project);
mkdirSync(folder, { recursive: true });
const token = randomBytes(24).toString("hex");
const env = { ...process.env, DEV_TOKEN: token };
env.BUILDX_CONFIG ??= folder + "/buildx";
for (const key of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete env[key];
const compose = parse(readFileSync("compose.demo.yml", "utf8"));
const files = readdirSync("migrations")
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort();
const mounts = compose.services.postgres.volumes.filter((v) =>
  v.includes("/docker-entrypoint-initdb.d/"),
);
assert.deepEqual(
  mounts.map((v) => v.split(":")[0]),
  files.map((f) => "./migrations/" + f),
);
assert.deepEqual(
  mounts.map((v) => v.split(":")[1]),
  files.map((f) => "/docker-entrypoint-initdb.d/" + f.slice(0, 3) + ".sql"),
);
const override = folder + "/override.yml";
writeFileSync(
  override,
  'services:\n  api:\n    ports: !override ["127.0.0.1:0:8080"]\n' +
    (env.COMPOSE_SMOKE_IMAGE
      ? "    image: " + JSON.stringify(env.COMPOSE_SMOKE_IMAGE) + "\n"
      : "") +
    (env.CODEX_PROXY_CERT
      ? "    build:\n      context: .\n      secrets: [proxy_ca]\nsecrets:\n  proxy_ca:\n    file: " +
        JSON.stringify(env.CODEX_PROXY_CERT) +
        "\n"
      : ""),
);
const base = [
  "--host=unix:///var/run/docker.sock",
  "compose",
  "-p",
  project,
  "-f",
  resolve("compose.demo.yml"),
  "-f",
  override,
];
const docker = (args, capture = false) => {
  const result = spawnSync("docker", [...base, ...args], {
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      "docker compose " +
        args[0] +
        " failed: " +
        (result.stderr || result.status),
    );
  return result.stdout?.trim();
};
try {
  docker([
    "up",
    env.COMPOSE_SMOKE_IMAGE ? "--no-build" : "--build",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
  ]);
  const schema = docker(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "harness",
      "-d",
      "harness",
      "-Atc",
      "SELECT h.version || ':' || p.version FROM harness_schema h,personal_schema p;",
    ],
    true,
  );
  assert.equal(schema, "6:13");
  const port = docker(["port", "api", "8080"], true);
  const url = "http://" + port;
  const api = async (path, body) => {
    const r = await fetch(url + "/api/v1" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(r.ok, path + ": " + r.status);
    return r.json();
  };
  const agents = await api("/agents");
  const session = await api("/sessions", { agentId: agents.items[0].id });
  const run = await api("/sessions/" + session.id + "/runs", {
    message: "Compose empty-volume smoke",
  });
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await api("/runs/" + run.id)).state;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state, "COMPLETED");
  console.log(
    JSON.stringify({
      status: "passed",
      migrations: files.length,
      schema,
      runState: state,
      emptyVolume: true,
    }),
  );
} catch (e) {
  try {
    docker(["logs", "--tail", "100"]);
  } catch {}
  throw e;
} finally {
  docker(["down", "-v", "--remove-orphans", "--timeout", "10"]);
}
