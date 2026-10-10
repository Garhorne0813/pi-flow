import { createHash } from "node:crypto";
import { Fault, type Skill } from "../domain.js";

export type SkillVolume = { bundle: string; path: string; volume: string };

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
