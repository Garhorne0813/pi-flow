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
    skill.path !== `/skills/uploaded/${key}/SKILL.md`
  )
    throw new Fault(403, "ALIYUN_SKILL_NOT_PUBLISHED");
  return {
    bundle: skill.bundle,
    path: skill.path,
    bucketPath: `${storage.skillUploadPrefix}/${key}`,
  };
}
