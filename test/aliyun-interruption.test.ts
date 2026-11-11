import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  interruptionProbe,
  assertSigkill,
} from "../scripts/lib/aliyun-interruption.js";

for (const replace of [false, true]) {
  test(`SIGKILL probe compiles and dies by the expected signal (${replace ? "after" : "before"} rename)`, async (t) => {
    const probe = interruptionProbe(replace);
    const compiled = spawnSync(
      "python3",
      ["-c", "import sys; compile(sys.stdin.read(), '<probe>', 'exec')"],
      { input: probe.python, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    await mkdir("work", { recursive: true });
    const root = await mkdtemp(resolve("work/interruption-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(root + "/probe.txt", "old-content");
    // Execute precisely the command sent to remote-script's bash subprocess.
    const result = spawnSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", probe.command],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, "SIGKILL");
    assertSigkill(
      { exitCode: -9, stdout: result.stdout, timedOut: false },
      replace,
    );
    assert.equal(
      await readFile(root + "/probe.txt", "utf8"),
      replace ? "committed-after-interruption" : "old-content",
    );
    if (!replace)
      assert.equal(
        await readFile(root + "/.interrupted.tmp", "utf8"),
        "committed-after-interruption",
      );
  });
}

test("syntax errors, ordinary failures, wrong phase markers and timeouts cannot pass the interruption probe", () => {
  for (const outcome of [
    { exitCode: 1, stdout: "", timedOut: false },
    { exitCode: 1, stdout: interruptionProbe(true).marker, timedOut: false },
    { exitCode: -9, stdout: "", timedOut: false },
    { exitCode: 137, stdout: interruptionProbe(false).marker, timedOut: false },
    { exitCode: -9, stdout: interruptionProbe(true).marker, timedOut: true },
  ])
    assert.throws(() => assertSigkill(outcome, true));
  assertSigkill(
    { exitCode: 137, stdout: interruptionProbe(true).marker, timedOut: false },
    true,
  );
});
