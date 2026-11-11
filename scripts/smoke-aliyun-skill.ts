import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AliyunE2BProvider,
  aliyunConfig,
} from "../src/sandbox/aliyun-provider.js";
import {
  OssSkillPackages,
  ossPackageWriter,
} from "../src/skills/oss-packages.js";

// Explicit opt-in: publishes one caller-supplied ZIP and creates a billable
// instance. Reads the mounted Skill; never executes scripts from the archive.
const zipPath = process.argv[2];
if (!zipPath)
  throw new Error("Usage: npm run smoke:aliyun:skill -- /path/to/skill.zip");
const config = aliyunConfig();
const writer = ossPackageWriter(config);
if (!writer)
  throw new Error(
    "Configure OSS publication credentials before this smoke test",
  );
const publisher = new OssSkillPackages(config, writer);
const provider = new AliyunE2BProvider(config);
const probe = randomUUID();
const prepared = await publisher.prepare(
  `smoke-${probe}`,
  {
    id: `smoke@${probe}`,
    name: "Smoke test",
    description: "Temporary publication probe",
    bundle: "default",
  },
  await readFile(zipPath),
);
let sid: string | undefined;
try {
  const volume = await provider.createVolume(`ws-smoke-${probe}`);
  sid = (await provider.create(volume, "default", [prepared.skill])).sandboxId;
  const read = (await provider.execute(sid, "read", {
    path: prepared.skill.path,
    _skillIds: [prepared.skill.id],
    _skillManifests: [
      { path: prepared.skill.path, digest: prepared.skill.digest },
    ],
    _skillOssUploads: [prepared.skill],
  })) as { text: string };
  assert.equal(
    createHash("sha256").update(read.text).digest("hex"),
    prepared.skill.digest,
  );
  console.log(
    "OSS ZIP publication / dynamic read-only Skill mount / manifest verification: passed",
  );
} finally {
  // If deletion fails, retain the package for inspection rather than removing
  // data still mounted by an instance whose cleanup was not confirmed.
  if (sid) await provider.kill(sid);
  await prepared.discard();
}
