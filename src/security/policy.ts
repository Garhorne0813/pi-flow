import { Fault, type AgentConfig, type State } from "../domain.js";
export function authorizeTool(s: State, config: AgentConfig, name: string) {
  const bare = name.replace(/^remote_/, "");
  if (
    s.policy?.disabledTools.some(
      (t) =>
        t === name || t === bare || (t === "mcp_*" && name.startsWith("mcp_")),
    )
  )
    throw new Fault(403, "TOOL_DISABLED");
  if (
    !name.startsWith("mcp_") &&
    !config.tools.includes(bare as AgentConfig["tools"][number])
  )
    throw new Fault(403, "TOOL_DENIED");
}
export function requiresApproval(
  config: AgentConfig,
  name: string,
  args: Record<string, unknown>,
) {
  if (!name.startsWith("mcp_") && !["write", "edit", "bash"].includes(name))
    return false;
  const mode = config.approval?.mode ?? "user";
  if (mode === "auto") return false;
  // Deliberately narrow: no shell expansion, redirects, pipes, or arbitrary flags.
  if (
    mode === "guarded" &&
    name === "bash" &&
    /^pwd$/.test(String(args.command))
  )
    return false;
  return true;
}
