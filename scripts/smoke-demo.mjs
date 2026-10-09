import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const token = randomBytes(24).toString("hex");
const child = spawn(process.execPath, ["dist/main.js"], {
  env: {
    ...process.env,
    HARNESS_MODE: "demo",
    DEV_TOKEN: token,
    PORT: "18081",
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
child.stderr.on("data", (d) => {
  errors += d;
});
child.stdout.resume();
const base = "http://127.0.0.1:18081";
async function request(path, body, extra = {}) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(
    res.ok,
    `${res.status}: ${await (res.ok ? Promise.resolve("") : res.text())}`,
  );
  return res.json();
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(base + "/health");
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(ready, "Server did not become ready: " + errors);
  const agents = await request("/api/v1/agents");
  const w = await request("/api/v1/workspaces", { name: "Smoke workspace" });
  const s = await request(`/api/v1/workspaces/${w.id}/sessions`, {
    agentVersionId: agents.items[0].id,
  });
  const run = await request(
    `/api/v1/sessions/${s.id}/runs`,
    { message: "Hello harness" },
    { "Idempotency-Key": "smoke" },
  );
  const again = await request(
    `/api/v1/sessions/${s.id}/runs`,
    { message: "Hello harness" },
    { "Idempotency-Key": "smoke" },
  );
  assert.equal(run.id, again.id);
  const events = await (
    await fetch(base + `/api/v1/runs/${run.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).text();
  assert.match(events, /event: message.delta/);
  assert.match(events, /event: run.completed/);
  const final = await request(`/api/v1/runs/${run.id}`);
  assert.equal(final.state, "COMPLETED");
  const uploaded = await request(`/api/v1/workspaces/${w.id}/files`, {
    path: "report.txt",
    content: "persisted through file API",
  });
  const file = await request(
    `/api/v1/workspaces/${w.id}/files/${uploaded.fileId}`,
  );
  assert.equal(file.text, "persisted through file API");
  console.log(
    JSON.stringify({
      status: "passed",
      runState: final.state,
      eventCount: (events.match(/^id:/gm) || []).length,
      idempotency: true,
      files: true,
    }),
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}
