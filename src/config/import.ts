import { readSkillTree, frontmatter } from "./skills.js";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  AgentConfig,
  Fault,
  type Actor,
  type State,
  type Skill,
  type McpRegistration,
} from "../domain.js";
import { replaceAgents } from "./agents.js";
import type { Registry } from "../store/registry.js";
const keySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const DirectoryAgent = AgentConfig.omit({
  systemPrompt: true,
  agentsMd: true,
}).extend({ key: keySchema.optional() });
export type DirectoryConfig = {
  agents: { key: string; config: AgentConfig }[];
  policy: { disabledTools: string[] };
  skills?: Skill[];
  mcp?: McpRegistration[];
};
async function text(path: string, optional = false) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`Symlinks are not allowed: ${path}`);
    return await readFile(path, "utf8");
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}
function yaml(source: string) {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length)
    throw new Error(doc.errors.map((e) => e.message).join("; "));
  return doc.toJS({ maxAliasCount: 0 });
}
export async function loadDirectoryConfig(
  root: string,
): Promise<DirectoryConfig> {
  const house = await text(join(root, "base/HOUSE.md"));
  const agents: DirectoryConfig["agents"] = [];
  for (const entry of (
    await readdir(join(root, "agents"), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink())
      throw new Error("Agent directory symlinks are not allowed");
    if (!entry.isDirectory()) continue;
    const key = keySchema.parse(entry.name),
      dir = join(root, "agents", key);
    const data = DirectoryAgent.parse(
      yaml(await text(join(dir, "agent.yaml"))),
    );
    if (data.key && data.key !== key)
      throw new Error("Agent key does not match directory");
    const { key: _, ...config } = data;
    const system = await text(join(dir, "SYSTEM.md")),
      instructions = await text(join(dir, "AGENTS.md"), true);
    const subagentDefinitions: Record<string, unknown> = {
      ...config.subagentDefinitions,
    };
    let childFiles: string[] = [];
    try {
      childFiles = await readdir(join(dir, "subagents"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const child of childFiles) {
      if (!/^[a-zA-Z0-9_-]+\.md$/.test(child))
        throw new Error("Invalid subagent file");
      const parsed = frontmatter(await text(join(dir, "subagents", child)));
      subagentDefinitions[child.slice(0, -3)] = {
        ...parsed.metadata,
        systemPrompt: parsed.body,
      };
    }
    agents.push({
      key,
      config: AgentConfig.parse({
        ...config,
        subagentDefinitions,
        systemPrompt: [house, system].join("\n\n"),
        agentsMd: instructions ? [instructions] : [],
      }),
    });
  }
  if (!agents.length) throw new Error("At least one Agent is required");
  const rawPolicy = await text(join(root, "base/policy.yaml"), true);
  const skills = await readSkillTree(join(root, "skills"));
  const rawMcp = await text(join(root, "mcp/servers.yaml"), true);
  const mcp = z
    .array(
      z
        .object({
          id: keySchema,
          endpointRef: z.string(),
          allowedTools: z.array(z.string()),
          enabled: z.boolean().default(true),
        })
        .strict(),
    )
    .parse(rawMcp ? yaml(rawMcp) : []);
  return {
    agents,
    skills,
    mcp,
    policy: z
      .object({ disabledTools: z.array(z.string()).default([]) })
      .strict()
      .parse(rawPolicy ? yaml(rawPolicy) : {}),
  };
}
export function importDirectory(
  s: State,
  tree: DirectoryConfig,
  a: Actor,
  replace = false,
) {
  if (!replace && Object.keys(s.managedAgents ?? {}).length)
    throw new Fault(
      409,
      "CONFIG_ALREADY_INITIALIZED",
      "Use --replace to explicitly replace existing configuration",
    );
  for (const sk of tree.skills ?? []) s.skills[sk.id] = sk;
  for (const mcp of tree.mcp ?? []) s.mcp[mcp.id] = mcp;
  const result = replaceAgents(s, tree.agents, a);
  s.policy = tree.policy;
  s.configRevisions!.global++;
  return result;
}
