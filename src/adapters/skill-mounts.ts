import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
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

export function validateSkillBindings(
  bindings: Record<string, SkillVolume>,
  roots: readonly string[] = [],
  checkSources = true,
) {
  HostSkillRootsSchema.parse(roots);
  const paths: string[] = [],
    volumes = new Set<string>(),
    sources: string[] = [];
  for (const binding of Object.values(bindings)) {
    SkillVolumeSchema.parse(binding);
    const target = binding.path.slice(0, -"/SKILL.md".length);
    if (paths.some((p) => overlaps(p, target)))
      throw new Fault(400, "SKILL_MOUNT_CONFLICT");
    paths.push(target);
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
      if (checkSources) validateHostSkillSource(binding.hostPath);
    }
  }
}
function overlaps(a: string, b: string) {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
// Cube's metadata protocol cannot attest source realpaths on a remote node.
// Host mode therefore requires the same storage at this path in the control
// processes and Cubelet; unavailable sources fail closed rather than guessing.
export function validateHostSkillSource(source: string) {
  try {
    if (realpathSync(source) !== source || !lstatSync(source).isDirectory())
      throw new Error("non-canonical source");
    const pending = [source];
    let count = 0;
    while (pending.length) {
      const dir = pending.pop()!;
      for (const name of readdirSync(dir)) {
        if (++count > 10000) throw new Error("source too large");
        const path = posix.join(dir, name),
          stat = lstatSync(path);
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
  const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  const paths: string[] = [];
  const ids = new Set<string>();
  for (const skill of sorted) {
    if (!skill.enabled || skill.bundle !== bundle)
      throw new Fault(403, "SKILL_DENIED");
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
