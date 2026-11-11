import OSS from "ali-oss";
import { createHash, randomUUID } from "node:crypto";
import { Fault, type Skill } from "../domain/model.js";
import { telemetry } from "../observability/telemetry.js";
import {
  readSkillZip,
  skillZipLimits,
  SkillUploadSlots,
  type SkillPackages,
  type SkillUploadFields,
} from "./packages.js";
import {
  ossSkillStorageId,
  uploadedOssSkillPath,
  storageOverlaps,
  type OssSkillStorage,
} from "./oss-storage.js";

const hash = (input: string | Buffer) =>
  createHash("sha256").update(input).digest("hex");

/** The transport only writes exact package objects; never lists/deletes a prefix. */
export interface OssPackageWriter {
  put(
    key: string,
    data: Buffer,
    executable: boolean,
    timeoutMs: number,
  ): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export function ossClient(
  storage: OssSkillStorage,
  env: NodeJS.ProcessEnv = process.env,
): OSS | undefined {
  const accessKeyId = env.ALIYUN_OSS_ACCESS_KEY_ID;
  const accessKeySecret = env.ALIYUN_OSS_ACCESS_KEY_SECRET;
  const stsToken = env.ALIYUN_OSS_SECURITY_TOKEN;
  if (!accessKeyId && !accessKeySecret && !stsToken) return undefined;
  if (
    !accessKeyId?.trim() ||
    !accessKeySecret?.trim() ||
    !env.ALIYUN_OSS_REGION?.trim()
  )
    throw new Error(
      "OSS Skill publication requires ALIYUN_OSS_ACCESS_KEY_ID, ALIYUN_OSS_ACCESS_KEY_SECRET and ALIYUN_OSS_REGION",
    );
  const options = {
    bucket: storage.bucket,
    endpoint: storage.endpoint,
    region: env.ALIYUN_OSS_REGION,
    accessKeyId,
    accessKeySecret,
    stsToken,
    secure: true,
    authorizationV4: true,
    timeout: 20000,
    retryMax: 0,
  };
  return new OSS(options);
}

export function ossPackageWriter(
  storage: OssSkillStorage,
  env: NodeJS.ProcessEnv = process.env,
): OssPackageWriter | undefined {
  const client = ossClient(storage, env);
  return client ? ossWriter(client) : undefined;
}
export function ossWriter(client: OSS): OssPackageWriter {
  return {
    async put(key, data, executable, timeoutMs) {
      await client.put(key, data, {
        timeout: timeoutMs,
        // Never overwrite an object, including after an ambiguous timeout.
        headers: {
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-mode": String(executable ? 0o100555 : 0o100444),
        },
        mime: "application/octet-stream",
      });
    },
    async remove(keys) {
      if (!keys.length) return;
      const result = await client.deleteMulti(keys, {
        quiet: false,
        timeout: 20000,
      });
      const deleted = new Set(result.deleted?.map((entry) => entry.Key));
      if (keys.some((key) => !deleted.has(key)))
        throw new Fault(502, "SKILL_OSS_CLEANUP_UNCONFIRMED");
    },
  };
}

export class OssSkillPackages
  extends SkillUploadSlots
  implements SkillPackages
{
  constructor(
    private readonly storage: OssSkillStorage,
    private readonly writer: OssPackageWriter | undefined,
  ) {
    super();
    if (storageOverlaps(storage.skillUploadPrefix, storage.workspacePrefix))
      throw new Error(
        "OSS Skill uploads must be separate from workspace storage",
      );
  }
  get configuration() {
    return { enabled: !!this.writer, ...skillZipLimits };
  }
  async prepare(tenantId: string, fields: SkillUploadFields, archive: Buffer) {
    if (!this.writer)
      throw new Fault(
        503,
        "SKILL_UPLOAD_DISABLED",
        "OSS Skill publication is not configured",
      );
    // Reuse all ZIP protections before issuing any OSS request.
    const files = await readSkillZip(archive);
    // Each attempt owns a different namespace. Concurrent API processes and
    // losing registry transactions can only clean up their own objects.
    const key = hash(JSON.stringify([tenantId, fields.id, randomUUID()]));
    const prefix = `${this.storage.skillUploadPrefix.slice(1)}/${key}/`;
    const attempted: string[] = [];
    const writer = this.writer;
    const discard = async () => {
      try {
        await writer.remove(attempted);
      } catch {
        const error = new Fault(502, "SKILL_OSS_CLEANUP_UNCONFIRMED");
        // Only an opaque package ID and tenant are logged, never SDK exceptions
        // that may include signed URLs, credentials or response headers.
        telemetry.error("skill_oss_cleanup", error, { tenantId, callId: key });
        throw error;
      }
    };
    const deadline = performance.now() + 120000;
    try {
      for (const file of files) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Fault(504, "SKILL_OSS_PUBLISH_TIMEOUT");
        const object = prefix + file.path;
        // Include the current request even if its acknowledgement is lost.
        attempted.push(object);
        await writer.put(
          object,
          file.data,
          file.executable,
          Math.min(20000, Math.ceil(remaining)),
        );
      }
    } catch {
      await discard();
      throw new Fault(
        502,
        "SKILL_OSS_PUBLISH_FAILED",
        "Skill publication to OSS failed; no version was registered",
      );
    }
    const skill: Skill = {
      ...fields,
      path: uploadedOssSkillPath(key),
      digest: hash(files.find((file) => file.path === "SKILL.md")!.data),
      versionDigest: hash(
        JSON.stringify(
          files
            .map((file) => [file.path, hash(file.data), file.executable])
            .sort(),
        ),
      ),
      enabled: true,
      ossUpload: {
        key,
        storageId: ossSkillStorageId(this.storage),
        archiveDigest: hash(archive),
        files: files.length,
        bytes: files.reduce((total, file) => total + file.data.length, 0),
      },
    };
    // The route calls discard only when registry failure is known to precede
    // commit. An uncertain database outcome must retain the published package.
    return { skill, discard };
  }
}
