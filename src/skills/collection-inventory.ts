import { CollectionLocation, collectionPath } from "./collection.js";
import type { CollectionIO } from "./oss-collections.js";

export async function inspectCollectionStorage(
  prefix: string,
  io: Pick<CollectionIO, "list" | "get">,
  options: { maxObjects?: number; timeoutMs?: number } = {},
) {
  const maxObjects = options.maxObjects ?? 100000;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    maxObjects > 1000000 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error("Invalid collection inspection limits");
  const root = prefix.slice(1) + "/";
  const deadline = Date.now() + timeoutMs;
  const timeout = () => {
    if (Date.now() >= deadline) throw new Error("Inspection timeout");
    return Math.min(20000, deadline - Date.now());
  };
  const referenced = new Set<string>();
  const artifacts = new Map<
    string,
    { selectionId: string; artifact: string; files: number; bytes: number }
  >();
  let objects = 0,
    logicalBytes = 0,
    readyCollections = 0,
    invalidReadyPointers = 0,
    unclassifiedObjects = 0,
    complete = true;
  let cursor: string | undefined;
  const seenCursors = new Set<string>(),
    seenObjects = new Set<string>();
  try {
    do {
      const page = await io.list(root, cursor, timeout());
      for (const entry of page.files) {
        if (objects >= maxObjects) {
          complete = false;
          break;
        }
        if (
          !entry.key.startsWith(root) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          seenObjects.has(entry.key)
        ) {
          complete = false;
          unclassifiedObjects++;
          continue;
        }
        seenObjects.add(entry.key);
        objects++;
        logicalBytes += entry.size;
        if (entry.key.endsWith("/")) continue;
        const relative = entry.key.slice(root.length);
        if (/^ready\/[a-f0-9]{64}\.json$/.test(relative)) {
          try {
            const value = await io.get(entry.key, 4096, timeout());
            const location = CollectionLocation.parse(
              JSON.parse(value!.data.toString()),
            );
            if (relative !== `ready/${location.selectionId}.json`)
              throw new Error("Mismatched pointer");
            referenced.add(collectionPath(prefix, location).slice(1));
            readyCollections++;
          } catch {
            invalidReadyPointers++;
            complete = false;
          }
          continue;
        }
        const match = /^([a-zA-Z0-9_-]{43})\/([a-f0-9]{32})\/.+$/.exec(
          relative,
        );
        if (
          !match ||
          Buffer.from(match[1]!, "base64url").toString("base64url") !== match[1]
        ) {
          unclassifiedObjects++;
          continue;
        }
        const artifactRoot = `${root}${match[1]}/${match[2]}`;
        const item = artifacts.get(artifactRoot) ?? {
          selectionId: Buffer.from(match[1]!, "base64url").toString("hex"),
          artifact: match[2]!,
          files: 0,
          bytes: 0,
        };
        item.files++;
        item.bytes += entry.size;
        artifacts.set(artifactRoot, item);
      }
      if (!complete || objects >= maxObjects) {
        if (page.cursor) complete = false;
        break;
      }
      cursor = page.cursor;
      if (cursor && seenCursors.has(cursor)) {
        complete = false;
        break;
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
  } catch {
    complete = false;
  }
  const unreferenced = [...artifacts]
    .filter(([key]) => !referenced.has(key))
    .map(([, value]) => value);
  return {
    complete,
    observedObjects: objects,
    logicalBytes,
    readyCollections,
    artifacts: artifacts.size,
    invalidReadyPointers,
    unclassifiedObjects,
    unreferencedArtifacts: unreferenced.length,
    unreferencedBytes: unreferenced.reduce((n, a) => n + a.bytes, 0),
    candidates: unreferenced.slice(0, 100),
    candidateListTruncated: unreferenced.length > 100,
  };
}

export function collectionInventoryAlerts(
  report: Awaited<ReturnType<typeof inspectCollectionStorage>>,
  thresholds: { warnBytes: number; warnCollections: number },
) {
  if (
    ![thresholds.warnBytes, thresholds.warnCollections].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new Error("Invalid collection storage alert thresholds");
  return [
    ...(!report.complete ? ["inspection_incomplete"] : []),
    ...(report.logicalBytes >= thresholds.warnBytes
      ? ["collection_bytes_threshold"]
      : []),
    ...(report.readyCollections >= thresholds.warnCollections
      ? ["collection_count_threshold"]
      : []),
    ...(report.unreferencedArtifacts
      ? ["unreferenced_artifacts_require_reconciliation"]
      : []),
    ...(report.unclassifiedObjects
      ? ["unclassified_objects_require_reconciliation"]
      : []),
  ];
}
