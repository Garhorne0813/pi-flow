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
