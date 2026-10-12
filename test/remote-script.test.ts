import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { remoteScript } from "../src/adapters/remote-script.js";
test("trusted remote Python contract guards paths, symlinks, optimistic edits and command timeout", async () => {
  const base = resolve("work/remote-" + crypto.randomUUID());
  const ws = base + "/workspace",
    skills = base + "/skills";
  await mkdir(ws, { recursive: true });
  await mkdir(skills);
  await writeFile(base + "/secret", "secret");
  await writeFile(skills + "/SKILL.md", "skill");
  await symlink(base + "/secret", ws + "/escape");
  const script = remoteScript
    .replaceAll("'/workspace'", JSON.stringify(ws))
    .replaceAll("'/skills'", JSON.stringify(skills));
  const run = (op: string, args: unknown) =>
    JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          script,
          Buffer.from(JSON.stringify({ op, args })).toString("base64"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  run("write", { path: "file", content: "hello" });
  const first = run("read", { path: "file" });
  assert.equal(first.text, "hello");
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => run("read", { path: "escape" }));
  assert.throws(() => run("read", { path: "../secret" }));
  assert.throws(() =>
    run("write", { path: skills + "/SKILL.md", content: "modified" }),
  );
  assert.equal(run("read", { path: skills + "/SKILL.md" }).text, "skill");
  assert.throws(() =>
    run("read", { path: skills + "/SKILL.md", _workspaceOnly: true }),
  );
  assert.throws(() =>
    run("edit", {
      path: "file",
      expectedHash: "0".repeat(64),
      oldText: "hello",
      newText: "bye",
    }),
  );
  run("edit", {
    path: "file",
    expectedHash: first.sha256,
    oldText: "hello",
    newText: "bye",
  });
  assert.equal(await readFile(ws + "/file", "utf8"), "bye");
  assert.deepEqual(run("ls", {}).entries, ["escape", "file"]);
  assert.equal(run("grep", { pattern: "bye" }).matches[0].text, "bye");
  const cmd = run("bash", { command: "printf hello", timeoutSeconds: 1 });
  assert.equal(cmd.stdout, "hello");
  const timeout = run("bash", { command: "sleep 3", timeoutSeconds: 1 });
  assert.equal(timeout.timedOut, true);
});

test("manifest integrity covers canonical, dot-dot and symlink aliases, grep and bash; helper reads remain supported", async () => {
  const { createHash } = await import("node:crypto");
  const base = resolve("work/integrity-" + crypto.randomUUID());
  const ws = base + "/workspace",
    skills = base + "/skills";
  await mkdir(ws, { recursive: true });
  await mkdir(skills + "/review/v1", { recursive: true });
  const manifest = skills + "/review/v1/SKILL.md";
  await writeFile(manifest, "registered\r\nmanifest");
  await writeFile(skills + "/review/v1/helper.py", "helper");
  await symlink(manifest, skills + "/review/v1/alias.md");
  await symlink(manifest, ws + "/skill-link");
  const script = remoteScript
    .replaceAll("'/workspace'", JSON.stringify(ws))
    .replaceAll("'/skills'", JSON.stringify(skills));
  const digest = createHash("sha256")
    .update("registered\r\nmanifest")
    .digest("hex");
  const run = (op: string, args: Record<string, unknown>) =>
    JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          script,
          Buffer.from(
            JSON.stringify({
              op,
              args: { ...args, _skillManifests: [{ path: manifest, digest }] },
            }),
          ).toString("base64"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  const aliases = [
    manifest,
    skills + "/review/v1/../v1/SKILL.md",
    skills + "/review/v1/alias.md",
    "skill-link",
  ];
  for (const path of aliases) {
    const result = run("read", { path });
    assert.equal(result.path, manifest);
    assert.equal(result.sha256, digest);
  }
  assert.equal(
    run("read", { path: skills + "/review/v1/helper.py" }).text,
    "helper",
  );
  assert.ok(
    run("grep", { path: skills, pattern: "registered" }).matches.length,
  );
  await writeFile(manifest, "drifted manifest");
  for (const path of aliases)
    assert.throws(() => run("read", { path }), /SKILL_DIGEST_MISMATCH/);
  assert.throws(
    () => run("grep", { path: skills, pattern: "drifted" }),
    /SKILL_DIGEST_MISMATCH/,
  );
  assert.throws(
    () => run("bash", { command: `cat '${manifest}'` }),
    /SKILL_DIGEST_MISMATCH/,
  );
  await writeFile(manifest, "registered\r\nmanifest");
  const { unlink } = await import("node:fs/promises");
  await unlink(manifest);
  await symlink(ws + "/skill-link", manifest); // Circular/unconfirmable manifest identity must fail closed.
  assert.throws(() => run("read", { path: manifest }));
});

test("host mount preflight rejects absent/rw mounts and symlinks before bash, and checks digest on readonly mounts", async () => {
  const { createHash } = await import("node:crypto");
  const base = resolve("work/host-mount-check-" + crypto.randomUUID());
  const ws = base + "/workspace",
    skills = base + "/skills",
    mount = skills + "/review/v1";
  await mkdir(ws, { recursive: true });
  await mkdir(mount, { recursive: true });
  const manifest = mount + "/SKILL.md",
    digest = createHash("sha256").update("skill").digest("hex");
  await writeFile(manifest, "skill");
  const mountinfo = base + "/mountinfo";
  const script = remoteScript
    .replaceAll("'/workspace'", JSON.stringify(ws))
    .replaceAll("'/skills'", JSON.stringify(skills))
    .replace("'/proc/self/mountinfo'", JSON.stringify(mountinfo));
  const run = () =>
    JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          script,
          Buffer.from(
            JSON.stringify({
              op: "bash",
              args: {
                command: "printf ran",
                _hostSkillMounts: [mount],
                _skillManifests: [{ path: manifest, digest }],
              },
            }),
          ).toString("base64"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  for (const flags of ["", "rw,relatime"]) {
    await writeFile(
      mountinfo,
      flags ? `1 0 0:1 / ${mount} ${flags} - virtiofs skill rw\n` : "",
    );
    assert.throws(run, /SKILL_HOST_MOUNT_UNCONFIRMED/);
  }
  await writeFile(
    mountinfo,
    `1 0 0:1 / ${mount} ro,relatime - virtiofs skill ro\n`,
  );
  assert.equal(run().stdout, "ran");
  await writeFile(manifest, "drift");
  assert.throws(run, /SKILL_DIGEST_MISMATCH/);
  await writeFile(manifest, "skill");
  await symlink(ws, mount + "/escape");
  assert.throws(run, /SKILL_HOST_SOURCE_UNSAFE/);
});
