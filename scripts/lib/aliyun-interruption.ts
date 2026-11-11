import assert from "node:assert/strict";
import { constants } from "node:os";

export function interruptionProbe(replace: boolean) {
  const marker = replace
    ? "PI_FLOW_BEFORE_SIGKILL_AFTER_RENAME"
    : "PI_FLOW_BEFORE_SIGKILL_BEFORE_RENAME";
  // Join complete lines so editor/formatter indentation cannot change Python.
  const python = [
    "import os, signal",
    "with open('.interrupted.tmp', 'w') as f:",
    "    f.write('committed-after-interruption')",
    "    f.flush()",
    "    os.fsync(f.fileno())",
    ...(replace ? ["os.replace('.interrupted.tmp', 'probe.txt')"] : []),
    `print('${marker}', flush=True)`,
    "os.kill(os.getpid(), signal.SIGKILL)",
  ].join("\n");
  const payload = Buffer.from(python).toString("base64");
  return {
    python,
    marker,
    command: `exec python3 -c "import base64;exec(base64.b64decode('${payload}'))"`,
  };
}

export function assertSigkill(
  outcome: { exitCode: number; timedOut: boolean; stdout: string },
  replace: boolean,
) {
  const signal = constants.signals.SIGKILL;
  assert.equal(
    outcome.timedOut,
    false,
    "Interruption must not be a command timeout",
  );
  assert.ok(
    outcome.exitCode === -signal || outcome.exitCode === 128 + signal,
    `Expected SIGKILL (-${signal} or ${128 + signal}), received ${outcome.exitCode}`,
  );
  assert.equal(
    outcome.stdout.trim(),
    interruptionProbe(replace).marker,
    "Probe must reach the intended pre-SIGKILL point",
  );
}
