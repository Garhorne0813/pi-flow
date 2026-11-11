import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AliyunE2BProvider,
  aliyunConfig,
} from "../src/sandbox/aliyun-provider.js";
import { SandboxCreationError } from "../src/sandbox/provider.js";
import { interruptionProbe, assertSigkill } from "./lib/aliyun-interruption.js";

// Explicit opt-in: creates three billable instances, at most two concurrently.
// Uses a unique OSS workspace and the real tool protocol, including fsync.
const provider = new AliyunE2BProvider(aliyunConfig());
const probe = randomUUID();
const volume = await provider.createVolume(`ws-smoke-${probe}`);
const instances = new Set<string>();
const start = async () => {
  try {
    const created = await provider.create(
      volume,
      "default",
      [],
      undefined,
      `smoke-${probe}`,
    );
    instances.add(created.sandboxId);
    return created.sandboxId;
  } catch (error) {
    if (
      error instanceof SandboxCreationError &&
      !error.cleanupConfirmed &&
      error.sandboxId
    )
      instances.add(error.sandboxId);
    throw error;
  }
};
const stop = async (sid: string) => {
  await provider.kill(sid);
  instances.delete(sid);
};
const read = async (sid: string) =>
  (await provider.execute(sid, "read", { path: "probe.txt" })) as {
    text: string;
    sha256: string;
  };
const interrupt = async (sid: string, replace: boolean) => {
  const outcome = (await provider.execute(sid, "bash", {
    command: interruptionProbe(replace).command,
    timeoutSeconds: 10,
  })) as { exitCode: number; timedOut: boolean; stdout: string };
  assertSigkill(outcome, replace);
};
try {
  const first = await start();
  const content = `persistence-${probe}`;
  await provider.execute(first, "write", { path: "probe.txt", content });
  const second = await start();
  assert.equal(
    (await read(second)).text,
    content,
    "second instance must see the write",
  );
  const initial = await read(first);
  await provider.execute(first, "edit", {
    path: "probe.txt",
    expectedHash: initial.sha256,
    oldText: content,
    newText: "edited",
  });
  assert.equal(
    (await read(second)).text,
    "edited",
    "second instance must see replacement",
  );
  await provider.execute(first, "delete", { path: "probe.txt" });
  await assert.rejects(read(second), { code: "FILE_NOT_FOUND" });
  await provider.execute(first, "write", {
    path: "probe.txt",
    content: "stable-before-interruption",
  });
  await interrupt(first, false);
  assert.equal(
    (await read(first)).text,
    "stable-before-interruption",
    "kill before rename must preserve old target",
  );
  await interrupt(first, true);
  assert.equal(
    (await read(second)).text,
    "committed-after-interruption",
    "other instance must see the replaced target after writer SIGKILL",
  );
  await stop(first);
  await stop(second);
  const recreated = await start();
  assert.equal(
    (await read(recreated)).text,
    "committed-after-interruption",
    "data must survive releasing all instances",
  );
  await provider.execute(recreated, "delete", { path: "probe.txt" });
  console.log(
    "Aliyun OSS write/edit/delete / cross-instance visibility / writer SIGKILL before-after rename / release-recreate persistence: passed",
  );
} finally {
  const pending = [...instances];
  const cleanup = await Promise.allSettled(pending.map(stop));
  const failed = pending.filter((_, i) => cleanup[i]!.status === "rejected");
  if (failed.length) {
    console.error(
      `Sandbox cleanup unconfirmed; reconcile manually: ${failed.join(", ")}`,
    );
    throw new Error("SMOKE_SANDBOX_CLEANUP_UNCONFIRMED");
  }
  await provider.destroyVolume(volume);
}
