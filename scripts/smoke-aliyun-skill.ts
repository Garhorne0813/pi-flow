import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AliyunE2BProvider,
  aliyunConfig,
} from "../src/sandbox/aliyun-provider.js";
import {
  OssSkillPackages,
  ossPackageWriter,
  ossClient,
} from "../src/skills/oss-packages.js";
import { runAliyunSkillSmoke } from "./lib/aliyun-skill-smoke.js";
import {
  OssSkillCollections,
  collectionIO,
} from "../src/skills/oss-collections.js";
import { uploadedOssSkillBinding } from "../src/skills/oss-storage.js";

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
const collections = new OssSkillCollections(
  config.skillCollectionPrefix,
  collectionIO(ossClient(config)!),
);
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
const provider = new AliyunE2BProvider(config, async (request) => {
  if (
    request.skills.length !== 1 ||
    request.skills[0]!.id !== prepared.skill.id
  )
    throw new Error("Unexpected smoke Skill selection");
  return collections.resolve(request.volume, request.scope, [
    {
      skill: prepared.skill,
      bucketPath: uploadedOssSkillBinding(prepared.skill, config)!.bucketPath,
    },
  ]);
});
await runAliyunSkillSmoke(provider, prepared, `ws-smoke-${probe}`);
