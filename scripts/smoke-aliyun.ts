import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AliyunE2BProvider,
  aliyunConfig,
} from "../src/sandbox/aliyun-provider.js";

// Explicit opt-in: creates two billable instances and a unique OSS prefix.
// Uses the actual remote tool protocol, including mount checks and fsync.
const provider = new AliyunE2BProvider(aliyunConfig());
const volume = await provider.createVolume(`ws-smoke-${randomUUID()}`);
const content = `persistence-${randomUUID()}`;
let sid: string | undefined;
try {
  sid = (await provider.create(volume, "default", [])).sandboxId;
  await provider.execute(sid, "write", { path: "probe.txt", content });
  await provider.kill(sid);
  sid = undefined;
  sid = (await provider.create(volume, "default", [])).sandboxId;
  const read = (await provider.execute(sid, "read", { path: "probe.txt" })) as {
    text: string;
    sha256: string;
  };
  assert.equal(read.text, content);
  await provider.execute(sid, "edit", {
    path: "probe.txt",
    expectedHash: read.sha256,
    oldText: content,
    newText: "verified",
  });
  assert.equal(
    (
      (await provider.execute(sid, "read", { path: "probe.txt" })) as {
        text: string;
      }
    ).text,
    "verified",
  );
  await provider.execute(sid, "delete", { path: "probe.txt" });
  console.log(
    "Aliyun create / secure commands / OSS write-edit-read / kill / recreate persistence: passed",
  );
} finally {
  if (sid) await provider.kill(sid);
  await provider.destroyVolume(volume);
}
