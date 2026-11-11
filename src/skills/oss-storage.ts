import { createHash } from "node:crypto";
import { Fault, type Skill } from "../domain/model.js";

export type OssSkillStorage = {
  bucket: string;
  endpoint: string;
  skillUploadPrefix: string;
  workspacePrefix: string;
};

export const storageOverlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

export function ossSkillStorageId(storage: OssSkillStorage) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        storage.bucket,
        new URL(storage.endpoint).origin,
        storage.skillUploadPrefix,
      ]),
    )
    .digest("hex");
}

export function uploadedOssSkillPath(key: string) {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Fault(403, "ALIYUN_SKILL_NOT_PUBLISHED");
  // Encode all 256 identity bits in 43 URL-safe characters. The mountDir is
  // 60 characters, below OSS's conservative 64-character service limit.
  return `/skills/uploaded/${Buffer.from(key, "hex").toString("base64url")}/SKILL.md`;
}

export function uploadedOssSkillBinding(
  skill: Pick<Skill, "bundle" | "path" | "hostUpload" | "ossUpload">,
  storage: OssSkillStorage,
) {
  if (skill.hostUpload) throw new Fault(403, "ALIYUN_SKILL_NOT_PUBLISHED");
  if (!skill.ossUpload) return undefined;
  const { key, storageId } = skill.ossUpload;
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    storageId !== ossSkillStorageId(storage) ||
    (skill.path !== uploadedOssSkillPath(key) &&
      skill.path !== `/skills/uploaded/${key}/SKILL.md`)
  )
    throw new Fault(403, "ALIYUN_SKILL_NOT_PUBLISHED");
  return {
    bundle: skill.bundle,
    path: skill.path,
    bucketPath: `${storage.skillUploadPrefix}/${key}`,
  };
}
