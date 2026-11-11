import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AliyunE2BProvider,
  aliyunConfig,
} from "../src/sandbox/aliyun-provider.js";
import {
  OssSkillPackages,
  ossPackageWriter,
} from "../src/skills/oss-packages.js";
import { runAliyunSkillSmoke } from "./lib/aliyun-skill-smoke.js";

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
await runAliyunSkillSmoke(provider, prepared, `ws-smoke-${probe}`);
