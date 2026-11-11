import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type OSS from "ali-oss";
import { Fault, type Skill } from "../domain/model.js";
import { telemetry } from "../observability/telemetry.js";
import { skillMountPath } from "../sandbox/skill-mounts.js";
import {
  collectionId,
  collectionPath,
  CollectionLocation,
  collectionLimits,
} from "./collection.js";
import { ossWriter } from "./oss-packages.js";

export interface CollectionIO {
  get(
    key: string,
    limit: number,
    timeout: number,
  ): Promise<{ data: Buffer; executable: boolean } | undefined>;
  list(
    prefix: string,
    cursor: string | undefined,
    timeout: number,
  ): Promise<{ files: { key: string; size: number }[]; cursor?: string }>;
  put(
    key: string,
    data: Buffer,
    executable: boolean,
    timeout: number,
  ): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
const conflict = (e: unknown) => (e as { status?: number })?.status === 409;
const hash = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
export function collectionIO(client: OSS): CollectionIO {
  const writer = ossWriter(client);
  return {
    ...writer,
    async get(key, limit, timeout) {
      try {
        const r =
          limit === 0
            ? await client.head(key, { timeout })
            : await client.get(key, undefined, {
                timeout,
                headers: { Range: `bytes=0-${limit}` },
              });
        if (
          limit === 0 &&
          Number(
            (r.res.headers as Record<string, string>)["content-length"],
          ) !== 0
        )
          throw new Fault(409, "SKILL_COLLECTION_SOURCE_CHANGED");
        const data = "content" in r ? Buffer.from(r.content) : Buffer.alloc(0);
        if (data.length > limit) throw new Fault(413, "SKILL_COLLECTION_LIMIT");
        const mode = Number(
          (r.res.headers as Record<string, string>)["x-oss-meta-mode"] ?? 0,
        );
        if (
          mode &&
          (!Number.isSafeInteger(mode) || ![0, 0x8000].includes(mode & 0xf000))
        )
          throw new Fault(403, "SKILL_COLLECTION_UNSAFE_SOURCE");
        return { data, executable: !!(mode & 0o111) };
      } catch (e) {
        if ((e as { status?: number })?.status === 404) return undefined;
        throw e;
      }
    },
    async list(prefix, cursor, timeout) {
      const r = await client.listV2(
        { prefix, "continuation-token": cursor, "max-keys": 1000 },
        { timeout },
      );
      if (r.isTruncated && !r.nextContinuationToken)
        throw new Fault(502, "SKILL_COLLECTION_INVALID_PAGE");
      return {
        files: (r.objects ?? []).map((o) => ({
          key: o.name,
          size: Number(o.size),
        })),
        cursor: r.isTruncated ? r.nextContinuationToken : undefined,
      };
    },
    async remove(keys) {
      const deadline = Date.now() + 20000;
      for (let i = 0; i < keys.length; i += 1000) {
        if (Date.now() >= deadline)
          throw new Fault(502, "SKILL_COLLECTION_CLEANUP_UNCONFIRMED");
        const batch = keys.slice(i, i + 1000);
        const r = await client.deleteMulti(batch, {
          quiet: false,
          timeout: Math.max(1, deadline - Date.now()),
        });
        const deleted = new Set(r.deleted?.map((o) => o.Key));
        if (batch.some((key) => !deleted.has(key)))
          throw new Fault(502, "SKILL_COLLECTION_CLEANUP_UNCONFIRMED");
      }
    },
  };
}

export class OssSkillCollections {
  private active = 0;
  constructor(
    private prefix: string,
    private io: CollectionIO,
  ) {}
  async resolve(
    volume: string,
    scope: string,
    sources: { skill: Skill; bucketPath: string }[],
  ): Promise<CollectionLocation> {
    if (this.active >= 2) {
      telemetry.count("skill_collections_busy_total");
      throw new Fault(429, "SKILL_COLLECTION_BUSY");
    }
    const started = performance.now();
    this.active++;
    try {
      return await this.publish(volume, scope, sources);
    } catch (error) {
      telemetry.count("skill_collections_resolve_failed_total");
      if (
        error instanceof Fault &&
        error.code === "SKILL_COLLECTION_COMMIT_UNCONFIRMED"
      )
        telemetry.count("skill_collections_commit_unconfirmed_total");
      if (error instanceof Fault) throw error;
      throw new Fault(502, "SKILL_COLLECTION_PUBLISH_FAILED");
    } finally {
      this.active--;
      telemetry.duration(
        "skill_collections_prepare",
        performance.now() - started,
      );
    }
  }
  private async publish(
    volume: string,
    scope: string,
    sources: { skill: Skill; bucketPath: string }[],
  ) {
    if (!sources.length || sources.length > collectionLimits.maxSkills)
      throw new Fault(400, "SKILL_COLLECTION_LIMIT");
    const selectionId = collectionId(volume, scope);
    const marker = `${this.prefix.slice(1)}/ready/${selectionId}.json`;
    const deadline = Date.now() + 90000;
    const timeout = () => {
      const left = deadline - Date.now();
      if (left <= 0) throw new Fault(504, "SKILL_COLLECTION_TIMEOUT");
      return Math.min(20000, left);
    };
    const ready = async () => {
      const stored = await this.io.get(marker, 4096, timeout());
      if (!stored) return undefined;
      const location = CollectionLocation.parse(
        JSON.parse(stored.data.toString()),
      );
      if (location.selectionId !== selectionId)
        throw new Fault(409, "SKILL_COLLECTION_IDENTITY_MISMATCH");
      return location;
    };
    const existing = await ready();
    if (existing) {
      telemetry.count("skill_collections_cache_hits_total");
      return existing;
    }
    telemetry.count("skill_collections_builds_started_total");
    const location = {
      selectionId,
      artifact: randomUUID().replaceAll("-", ""),
    };
    const target = collectionPath(this.prefix, location).slice(1) + "/";
    const attempted: string[] = [];
    let files = 0,
      bytes = 0,
      markerStarted = false;
    const discard = async () => {
      try {
        await this.io.remove(attempted);
        telemetry.count(
          "skill_collections_private_objects_removed_total",
          attempted.length,
        );
      } catch {
        telemetry.count("skill_collections_cleanup_unconfirmed_total");
        telemetry.error(
          "skill_collection_cleanup",
          new Fault(502, "SKILL_COLLECTION_CLEANUP_UNCONFIRMED"),
          { callId: selectionId },
        );
      }
    };
    try {
      for (const { skill, bucketPath } of sources) {
        const source = bucketPath.slice(1) + "/";
        const destination =
          skillMountPath(skill).slice("/skills/".length) + "/";
        let cursor: string | undefined,
          manifest = false;
        const cursors = new Set<string>(),
          names = new Set<string>();
        const inventory: (string | boolean)[][] = [];
        do {
          const page = await this.io.list(source, cursor, timeout());
          for (const entry of page.files) {
            if (!entry.key.startsWith(source))
              throw new Fault(403, "SKILL_COLLECTION_UNSAFE_SOURCE");
            const relative = entry.key.slice(source.length);
            if (entry.key.endsWith("/")) continue;
            if (
              !relative ||
              relative.length > 1024 ||
              relative.startsWith("/") ||
              /[\x00-\x1f\x7f\\:]/.test(relative) ||
              posix.normalize(relative) !== relative ||
              relative.split("/").some((p) => !p || p === "." || p === "..") ||
              relative.split("/").length > 16 ||
              names.has(relative.toLowerCase())
            )
              throw new Fault(403, "SKILL_COLLECTION_UNSAFE_SOURCE");
            const lower = relative.toLowerCase();
            if (
              [...names].some(
                (n) => n.startsWith(lower + "/") || lower.startsWith(n + "/"),
              )
            )
              throw new Fault(403, "SKILL_COLLECTION_UNSAFE_SOURCE");
            names.add(lower);
            if (
              !Number.isSafeInteger(entry.size) ||
              entry.size < 0 ||
              entry.size > collectionLimits.maxFileBytes ||
              ++files > collectionLimits.maxFiles ||
              bytes + entry.size > collectionLimits.maxBytes
            )
              throw new Fault(413, "SKILL_COLLECTION_LIMIT");
            const object = await this.io.get(entry.key, entry.size, timeout());
            if (!object || object.data.length !== entry.size)
              throw new Fault(409, "SKILL_COLLECTION_SOURCE_CHANGED");
            bytes += object.data.length;
            const digest = hash(object.data);
            if (relative === "SKILL.md") {
              if (object.data.length > 128 * 1024)
                throw new Fault(413, "SKILL_COLLECTION_LIMIT");
              if (digest !== skill.digest)
                throw new Fault(409, "SKILL_DIGEST_MISMATCH");
              manifest = true;
            }
            inventory.push([relative, digest, object.executable]);
            const key = target + destination + relative;
            if (Buffer.byteLength(key) > 1023)
              throw new Fault(413, "SKILL_COLLECTION_LIMIT");
            attempted.push(key);
            await this.io.put(key, object.data, object.executable, timeout());
          }
          cursor = page.cursor;
          if (cursor && cursors.has(cursor))
            throw new Fault(502, "SKILL_COLLECTION_INVALID_PAGE");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (!manifest) throw new Fault(409, "SKILL_IDENTITY_UNCONFIRMED");
        if (
          skill.ossUpload &&
          skill.versionDigest &&
          hash(JSON.stringify(inventory.sort())) !== skill.versionDigest
        )
          throw new Fault(409, "SKILL_COLLECTION_SOURCE_CHANGED");
      }
      markerStarted = true;
      try {
        await this.io.put(
          marker,
          Buffer.from(JSON.stringify(location)),
          false,
          timeout(),
        );
      } catch (e) {
        if (!conflict(e))
          throw new Fault(502, "SKILL_COLLECTION_COMMIT_UNCONFIRMED");
        const winner = await ready();
        if (!winner)
          throw new Fault(502, "SKILL_COLLECTION_COMMIT_UNCONFIRMED");
        if (winner.artifact !== location.artifact) await discard();
        return winner;
      }
      telemetry.count("skill_collections_published_total");
      telemetry.count("skill_collections_published_files_total", files);
      telemetry.count("skill_collections_published_bytes_total", bytes);
      return location;
    } catch (error) {
      // A timed-out marker write may have published this artifact. Never delete
      // a possibly referenced collection, even if the caller timed out.
      if (!markerStarted) await discard();
      if (error instanceof Fault) throw error;
      throw new Fault(502, "SKILL_COLLECTION_PUBLISH_FAILED");
    }
  }
}
