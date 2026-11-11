import { resolve } from "node:path";
import { readSkillTree, materializeSkills } from "./skills.js";
if (!process.env.SKILL_DELIVER_DIR)
  throw new Error("SKILL_DELIVER_DIR required");
const skills = await readSkillTree(
  resolve(process.env.CONFIG_DIR ?? "config", "skills"),
);
await materializeSkills(skills, resolve(process.env.SKILL_DELIVER_DIR));
console.log(`Delivered ${skills.length} immutable Skills`);
