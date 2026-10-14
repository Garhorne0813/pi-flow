import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { posix } from "node:path";
import { crc32 } from "node:zlib";
import { fromBuffer, type ZipFile, type Entry } from "yauzl";
import { z } from "zod";
import { Fault, type Skill } from "./domain.js";
import {
  HostSkillRootsSchema,
  type SkillVolume,
} from "./adapters/skill-mounts.js";

export const skillZipLimits = Object.freeze({
  maxArchiveBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 1000,
  maxTreeEntries: 10000,
  maxConcurrentUploads: 2,
});
export const SkillUploadFields = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/)
      .max(200),
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(""),
    bundle: z.string().min(1).max(200),
  })
  .strict();
export type SkillUploadFields = z.infer<typeof SkillUploadFields>;
type PackageFile = { path: string; data: Buffer; executable: boolean };
const invalid = (message: string) =>
  new Fault(400, "INVALID_SKILL_ZIP", message);
const tooLarge = () =>
  new Fault(
    413,
    "SKILL_ZIP_LIMIT",
    "Skill ZIP exceeds the archive, expanded-size or file-count limit",
  );
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

/** Validate the entire archive before writing anything to shared host storage. */
export async function readSkillZip(buffer: Buffer): Promise<PackageFile[]> {
  if (buffer.length > skillZipLimits.maxArchiveBytes) throw tooLarge();
  if (!buffer.length)
    throw invalid("Choose a non-empty ZIP containing one SKILL.md");
  let zip: ZipFile;
  try {
    zip = await new Promise<ZipFile>((resolve, reject) =>
      fromBuffer(
        buffer,
        { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
        (error, opened) => (error ? reject(error) : resolve(opened!)),
      ),
    );
  } catch {
    throw invalid("Unreadable ZIP archive");
  }
  try {
    if (zip.entryCount > skillZipLimits.maxFiles * 2) throw tooLarge();
    const files = await new Promise<PackageFile[]>((resolve, reject) => {
      const files: PackageFile[] = [];
      const seen = new Map<string, boolean>();
      let expanded = 0,
        failed = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(
          error instanceof Fault
            ? error
            : invalid("Corrupt or unsupported ZIP entry"),
        );
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!failed) resolve(files);
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const directory = entry.fileName.endsWith("/");
          const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
          if (
            !name ||
            name.length > 1024 ||
            /[\x00-\x1f\x7f\\:]/.test(name) ||
            name.startsWith("/") ||
            name.split("/").some((p) => !p || p === "." || p === "..") ||
            name.split("/").length > 16
          )
            throw invalid("Archive contains an unsafe path");
          const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (kind && kind !== (directory ? 0x4000 : 0x8000))
            throw invalid("Links and special files are not allowed");
          if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod))
            throw invalid(
              "Encrypted or unsupported ZIP entries are not allowed",
            );
          const key = name.toLowerCase();
          if (
            seen.has(key) ||
            [...seen].some(
              ([p, isDir]) =>
                (!isDir && key.startsWith(p + "/")) ||
                (!directory && p.startsWith(key + "/")),
            )
          )
            throw invalid("Archive contains duplicate or conflicting paths");
          seen.set(key, directory);
          expanded += entry.uncompressedSize;
          if (
            expanded > skillZipLimits.maxExpandedBytes ||
            entry.uncompressedSize > skillZipLimits.maxFileBytes ||
            !Number.isSafeInteger(expanded)
          )
            throw tooLarge();
          if (directory) {
            if (entry.uncompressedSize !== 0)
              throw invalid("Directory entries must be empty");
          } else {
            if (files.length >= skillZipLimits.maxFiles) throw tooLarge();
            const stream = await new Promise<import("node:stream").Readable>(
              (resolve, reject) =>
                zip.openReadStream(entry, (error, stream) =>
                  error ? reject(error) : resolve(stream),
                ),
            );
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              size += chunk.length;
              if (
                size > entry.uncompressedSize ||
                size > skillZipLimits.maxFileBytes
              ) {
                stream.destroy();
                throw tooLarge();
              }
              chunks.push(Buffer.from(chunk));
            }
            const data = Buffer.concat(chunks);
            if (size !== entry.uncompressedSize || crc32(data) !== entry.crc32)
              throw invalid("ZIP entry integrity check failed");
            files.push({
              path: name,
              data,
              executable: !!((entry.externalFileAttributes >>> 16) & 0o111),
            });
          }
          if (!failed) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    // Ignore common macOS packaging metadata, after validating and bounding it.
    const useful = files.filter(
      (f) =>
        !f.path.startsWith("__MACOSX/") &&
        posix.basename(f.path) !== ".DS_Store",
    );
    const manifests = useful.filter(
      (f) => posix.basename(f.path) === "SKILL.md",
    );
    if (manifests.length !== 1)
      throw invalid("ZIP must contain exactly one SKILL.md");
    const manifest = manifests[0]!;
    const prefix = posix.dirname(manifest.path);
    if (prefix !== "." && prefix.includes("/"))
      throw invalid(
        "Put SKILL.md at the ZIP root or inside one top-level skill directory",
      );
    if (prefix !== "." && useful.some((f) => !f.path.startsWith(prefix + "/")))
      throw invalid("ZIP contains files outside its single skill directory");
    if (!manifest.data.length || manifest.data.length > 128 * 1024)
      throw invalid("SKILL.md must be non-empty and at most 128 KiB");
    try {
      if (
        !new TextDecoder("utf-8", { fatal: true }).decode(manifest.data).trim()
      )
        throw new Error();
    } catch {
      throw invalid("SKILL.md must contain valid UTF-8 text");
    }
    const normalized = useful.map((f) => ({
      ...f,
      path: prefix === "." ? f.path : f.path.slice(prefix.length + 1),
    }));
    const dirs = new Set<string>();
    for (const file of normalized) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++)
        dirs.add(parts.slice(0, i).join("/"));
    }
    if (normalized.length + dirs.size > skillZipLimits.maxTreeEntries)
      throw tooLarge();
    return normalized;
  } finally {
    zip.close();
  }
}

export function skillUploadRoot(
  roots: readonly string[],
  configured = roots[0],
  bindings: Record<string, SkillVolume> = {},
) {
  if (configured === undefined) return undefined;
  HostSkillRootsSchema.parse([configured]);
  if (
    !roots.some(
      (root) => configured === root || configured.startsWith(root + "/"),
    )
  )
    throw new Fault(403, "SKILL_HOST_PATH_DENIED");
  const uploads = configured + "/uploads";
  for (const binding of Object.values(bindings))
    if (
      "hostPath" in binding &&
      (binding.hostPath === uploads ||
        binding.hostPath.startsWith(uploads + "/") ||
        uploads.startsWith(binding.hostPath + "/"))
    )
      throw new Fault(
        400,
        "SKILL_HOST_SOURCE_CONFLICT",
        "The upload namespace overlaps a deployment skill source",
      );
  return configured;
}
export function uploadedSkillBinding(
  skill: Pick<Skill, "path" | "bundle" | "hostUpload">,
  root?: string,
): SkillVolume | undefined {
  if (!skill.hostUpload) return undefined;
  const key = skill.hostUpload.key;
  if (
    !root ||
    !/^[a-f0-9]{64}$/.test(key) ||
    skill.path !== `/skills/uploaded/${key}/SKILL.md`
  )
    throw new Fault(403, "SKILL_VOLUME_NOT_REGISTERED");
  return {
    bundle: skill.bundle,
    path: skill.path,
    hostPath: `${root}/uploads/${key}/content`,
  };
}

export class HostSkillPackages {
  private activeUploads = 0;
  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeUploads >= skillZipLimits.maxConcurrentUploads)
      throw new Fault(
        429,
        "SKILL_UPLOAD_BUSY",
        "Another Skill upload is in progress; retry shortly",
      );
    this.activeUploads++;
    try {
      return await fn();
    } finally {
      this.activeUploads--;
    }
  }
  constructor(readonly root: string | undefined) {}
  get configuration() {
    return { enabled: !!this.root, ...skillZipLimits };
  }
  async prepare(tenantId: string, fields: SkillUploadFields, archive: Buffer) {
    if (!this.root)
      throw new Fault(
        503,
        "SKILL_UPLOAD_DISABLED",
        "Host Skill uploads are not configured",
      );
    const files = await readSkillZip(archive);
    const root = this.root;
    try {
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        throw new Error();
    } catch {
      throw new Fault(
        503,
        "SKILL_UPLOAD_STORAGE_UNAVAILABLE",
        "Provision a canonical, writable shared Skill upload root for API, Workers and Cubelet",
      );
    }
    const uploads = root + "/uploads";
    try {
      await mkdir(uploads, { mode: 0o755 });
      await chmod(uploads, 0o755);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Fault(503, "SKILL_UPLOAD_STORAGE_UNAVAILABLE");
    }
    try {
      if (
        (await realpath(uploads)) !== uploads ||
        !(await lstat(uploads)).isDirectory()
      )
        throw new Error();
    } catch {
      throw new Fault(403, "SKILL_HOST_SOURCE_UNSAFE");
    }
    const key = hash(JSON.stringify([tenantId, fields.id]));
    const target = uploads + "/" + key;
    const stage = await mkdtemp(uploads + "/.stage-");
    const directories = new Set<string>([stage]);
    const discardStage = async () => {
      for (const dir of directories) await chmod(dir, 0o755).catch(() => {});
      await rm(stage, { recursive: true, force: true });
    };
    let reserved = false,
      moved = false;
    try {
      for (const file of files) {
        let dir = stage;
        for (const component of file.path.split("/").slice(0, -1)) {
          dir += "/" + component;
          await mkdir(dir, { recursive: true, mode: 0o755 });
          directories.add(dir);
        }
        const filePath = stage + "/" + file.path;
        await writeFile(filePath, file.data, { flag: "wx", mode: 0o600 });
        // Explicit chmod avoids a restrictive API umask making files unreadable
        // to the distinct Worker/Cube sandbox execution identities.
        await chmod(filePath, file.executable ? 0o555 : 0o444);
      }
      try {
        await mkdir(target, { mode: 0o755 });
        reserved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Fault(
            409,
            "IMMUTABLE_SKILL_PACKAGE",
            "This Skill version already has a package; use a new version ID",
          );
        throw error;
      }
      await rename(stage, target + "/content");
      moved = true;
      for (const dir of [...directories].sort((a, b) => b.length - a.length))
        await chmod(dir.replace(stage, target + "/content"), 0o555);
      await chmod(target, 0o555);
      const skill: Skill = {
        ...fields,
        path: `/skills/uploaded/${key}/SKILL.md`,
        digest: hash(files.find((f) => f.path === "SKILL.md")!.data),
        enabled: true,
        hostUpload: {
          key,
          archiveDigest: hash(archive),
          files: files.length,
          bytes: files.reduce((sum, f) => sum + f.data.length, 0),
        },
      };
      // Only call discard when metadata definitely did not commit. An uncertain
      // database outcome must not delete files potentially referenced by a Skill.
      const discard = async () => {
        await chmod(target, 0o755);
        for (const dir of directories)
          await chmod(dir.replace(stage, target + "/content"), 0o755);
        await rm(target, { recursive: true, force: true });
      };
      return { skill, discard };
    } catch (error) {
      await discardStage();
      if (reserved) {
        await chmod(target, 0o755).catch(() => {});
        if (moved)
          for (const dir of directories)
            await chmod(dir.replace(stage, target + "/content"), 0o755).catch(
              () => {},
            );
        await rm(target, { recursive: true, force: true });
      }
      throw error;
    }
  }
}
