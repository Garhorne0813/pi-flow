import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { Fault, type Skill } from "../domain.js";

const identity = {
  bundle: z.string().min(1),
  path: z.string().regex(/^\/skills\/(?:[a-zA-Z0-9_-]+\/)+SKILL\.md$/),
};
const absoluteDirectory = z
  .string()
  .refine(
    (v) =>
      v.startsWith("/") &&
      v !== "/" &&
      !/[\x00-\x1f\\]/.test(v) &&
      posix.normalize(v) === v &&
      !v.endsWith("/"),
    "Expected a canonical absolute directory path (no traversal or trailing slash)",
  );
export const SkillVolumeSchema = z.union([
  z.object({ ...identity, volume: z.string().min(1) }).strict(),
  z.object({ ...identity, hostPath: absoluteDirectory }).strict(),
]);
export type SkillVolume = z.infer<typeof SkillVolumeSchema>;
export const HostSkillRootsSchema = z.array(absoluteDirectory);
export const DEFAULT_HOST_SKILL_ROOTS: readonly string[] = Object.freeze([
  "/data/agent-skills",
]);

export function validateSkillBindings(
  bindings: Record<string, SkillVolume>,
  roots: readonly string[] = DEFAULT_HOST_SKILL_ROOTS,
) {
  HostSkillRootsSchema.parse(roots);
  const volumes = new Set<string>(),
    sources: string[] = [];
  for (const binding of Object.values(bindings)) {
    SkillVolumeSchema.parse(binding);
    if ("volume" in binding) {
      if (volumes.has(binding.volume))
        throw new Error("Each skill version requires a separate volume");
      volumes.add(binding.volume);
    } else {
      if (!roots.some((r) => binding.hostPath.startsWith(r + "/")))
        throw new Fault(403, "SKILL_HOST_PATH_DENIED");
      if (sources.some((p) => overlaps(p, binding.hostPath)))
        throw new Fault(400, "SKILL_HOST_SOURCE_CONFLICT");
      sources.push(binding.hostPath);
    }
  }
}
function overlaps(a: string, b: string) {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
// Cube's metadata protocol cannot attest source realpaths on a remote node.
// Host mode therefore requires the same storage at this path in the control
// processes and Cubelet; unavailable sources fail closed rather than guessing.
export async function validateHostSkillSource(source: string) {
  try {
    if (
      (await realpath(source)) !== source ||
      !(await lstat(source)).isDirectory()
    )
      throw new Error("non-canonical source");
    const pending = [source];
    let count = 0;
    while (pending.length) {
      const dir = pending.pop()!;
      for (const name of await readdir(dir)) {
        if (++count > 10000) throw new Error("source too large");
        const path = posix.join(dir, name),
          stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          throw new Error("unsafe source entry");
        if (stat.isDirectory()) pending.push(path);
      }
    }
  } catch {
    throw new Fault(403, "SKILL_HOST_SOURCE_UNSAFE");
  }
}

export function skillMountPath(skill: Skill) {
  if (!/^\/skills\/(?:[a-zA-Z0-9_-]+\/)+SKILL\.md$/.test(skill.path))
    throw new Fault(400, "INVALID_SKILL_PATH");
  return skill.path.slice(0, -"/SKILL.md".length);
}

export function skillScope(bundle: string, skills: readonly Skill[]) {
  for (const skill of skills)
    if (!skill.enabled) throw new Fault(403, "SKILL_DENIED");
  return skillIdentityScope(bundle, skills);
}
// Identity is independent of dynamic revocation. Historical task comparison
// must not remount skills or re-authorize them merely to identify a scope.
export function skillIdentityScope(bundle: string, skills: readonly Skill[]) {
  const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  const paths: string[] = [];
  const ids = new Set<string>();
  for (const skill of sorted) {
    if (skill.bundle !== bundle) throw new Fault(403, "SKILL_DENIED");
    const path = skillMountPath(skill);
    if (
      ids.has(skill.id) ||
      paths.some(
        (p) =>
          p === path || p.startsWith(path + "/") || path.startsWith(p + "/"),
      )
    )
      throw new Fault(400, "SKILL_MOUNT_CONFLICT");
    ids.add(skill.id);
    paths.push(path);
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        bundle,
        skills: sorted.map((s) => ({
          id: s.id,
          path: s.path,
          digest: s.digest,
        })),
      }),
    )
    .digest("hex");
}
