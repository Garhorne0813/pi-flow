import { randomUUID } from "node:crypto";
import { z } from "zod";
export const id = () => randomUUID();
export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export type Actor = {
  tenantId: string;
  userId: string;
  admin: boolean;
  expiresAt?: number;
};
export const tools = [
  "read",
  "write",
  "edit",
  "bash",
  "ls",
  "grep",
  "find",
  "todo",
  "ask_user_question",
  "delegate_to_agent",
] as const;
export const AgentConfig = z
  .object({
    name: z.string().min(1).max(100),
    systemPrompt: z.string().max(32000),
    agentsMd: z.array(z.string().max(32000)).default([]),
    model: z
      .object({ provider: z.string().min(1), modelId: z.string().min(1) })
      .strict(),
    tools: z.array(z.enum(tools)).max(10),
    skills: z.array(z.string()).default([]),
    mcpServers: z.array(z.string()).max(16).default([]),
    subagents: z.array(z.string()).default([]),
    skillBundle: z.string().min(1),
    maxTokens: z.number().int().min(100).max(1000000).default(100000),
    maxSteps: z.number().int().min(1).max(100).default(30),
    timeoutSeconds: z.number().int().min(1).max(1800).default(600),
    maxSubagents: z.number().int().min(0).max(5).default(2),
    maxDepth: z.number().int().min(0).max(3).default(1),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfig>;
export type Agent = { id: string; activeVersionId: string };
export type AgentVersion = {
  agentId?: string;
  id: string;
  config: AgentConfig;
  digest: string;
  publishedAt: string;
  enabled: boolean;
  allowedUsers?: string[];
};
export type Workspace = {
  id: string;
  name: string;
  ownerId: string;
  members: Record<string, "owner" | "editor" | "viewer">;
  volumeId?: string;
  sandboxId?: string;
  sandboxSkillScope?: string;
  // Per-sandbox data-plane token returned by Cube create; connect does not
  // re-issue it, so it must survive Worker restarts with the Sandbox record.
  sandboxTrafficToken?: string;
  sandboxState?: "active" | "paused" | "unknown";
  sandboxLastUsedAt?: number;
  sandboxSnapshots?: Record<string, SandboxSnapshot>;
  sandboxSkills?: string[];
  bundle?: string;
  lock?: {
    owner: string;
    expires: number;
    kind?: "agent" | "files" | "lifecycle";
  };
  fileLock?: { owner: string; expires: number };
  deleting?: boolean;
};
export type Session = {
  id: string;
  workspaceId: string;
  agentVersionId: string; // Compatibility alias for effectiveVersionId.
  agentId?: string;
  effectiveVersionId?: string;
  entries: unknown[];
  createdAt: string;
};
export type SandboxSnapshot = {
  id: string;
  name?: string;
  createdAt: string;
  sandboxId: string;
  skillScope: string;
  bundle: string;
  skills: string[];
};
export type RunState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_INPUT"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export const terminal = (s: RunState) =>
  ["COMPLETED", "FAILED", "CANCELLED"].includes(s);
export type Run = {
  agentVersionId?: string;
  taskId?: string;
  rootRunId?: string;
  id: string;
  sessionId: string;
  actor: Actor;
  prompt: string;
  state: RunState;
  key?: string;
  requestDigest: string;
  createdAt: string;
  lease?: { owner: string; expires: number };
  cancelRequested?: boolean;
  error?: string;
  parentRunId?: string;
  depth: number;
  steps: number;
  children: number;
  tokens?: number;
  capabilities?: AgentConfig;
  deadline?: number;
  resumedFrom?: string;
  requestId?: string;
  traceparent?: string;
  startedAt?: string;
  endedAt?: string;
};
export type Event = {
  eventId: number;
  runId: string;
  sessionId: string;
  type: string;
  timestamp: string;
  data: unknown;
};
export type Interaction = {
  id: string;
  runId: string;
  kind: "question" | "approval";
  payload: unknown;
  resolved: boolean;
  response?: string;
  continuationRunId?: string;
};
export type Skill = {
  id: string;
  name: string;
  description: string;
  bundle: string;
  path: string;
  digest: string;
  enabled: boolean;
};
export type McpRegistration = {
  id: string;
  endpointRef: string;
  allowedTools: string[];
  enabled: boolean;
};
export type Audit = {
  id: string;
  timestamp: string;
  actorId: string;
  action: string;
  resource: string;
  result: string;
};
export type State = {
  usage?: import("./usage.js").UsageState;
  logicalAgents: Record<string, Agent>;
  agents: Record<string, AgentVersion>;
  workspaces: Record<string, Workspace>;
  sessions: Record<string, Session>;
  runs: Record<string, Run>;
  events: Event[];
  interactions: Record<string, Interaction>;
  skills: Record<string, Skill>;
  mcp: Record<string, McpRegistration>;
  todos: Record<string, unknown>;
  audit: Audit[];
  sequence: number;
};
export const emptyState = (): State => ({
  logicalAgents: {},
  agents: {},
  workspaces: {},
  sessions: {},
  runs: {},
  events: [],
  interactions: {},
  skills: {},
  mcp: {},
  todos: {},
  audit: [],
  sequence: 0,
});
export function event(s: State, r: Run, type: string, data: unknown = {}) {
  const now = new Date().toISOString();
  if (type === "run.started") r.startedAt = now;
  if (["run.completed", "run.failed", "run.cancelled"].includes(type))
    r.endedAt = now;
  s.events.push({
    eventId: ++s.sequence,
    runId: r.id,
    sessionId: r.sessionId,
    type,
    timestamp: new Date().toISOString(),
    data,
  });
}
export function audit(
  s: State,
  a: Actor,
  action: string,
  resource: string,
  result = "allowed",
) {
  s.audit.push({
    id: id(),
    timestamp: new Date().toISOString(),
    actorId: a.userId,
    action,
    resource,
    result,
  });
}
export function workspace(
  s: State,
  a: Actor,
  wid: string,
  write = false,
): Workspace {
  const w = s.workspaces[wid];
  if (!w || w.deleting || !Object.hasOwn(w.members, a.userId))
    throw new Fault(404, "WORKSPACE_NOT_FOUND");
  if (write && w.members[a.userId] === "viewer")
    throw new Fault(403, "READ_ONLY");
  return w;
}
export function session(s: State, a: Actor, sid: string, write = false) {
  const v = s.sessions[sid];
  if (!v) throw new Fault(404, "SESSION_NOT_FOUND");
  workspace(s, a, v.workspaceId, write);
  return v;
}
export function run(s: State, a: Actor, rid: string, write = false) {
  const r = s.runs[rid];
  if (!r) throw new Fault(404, "RUN_NOT_FOUND");
  session(s, a, r.sessionId, write);
  return r;
}
export function admin(a: Actor) {
  if (!a.admin) throw new Fault(403, "ADMIN_REQUIRED");
}
export function intersect(
  parent: AgentConfig,
  child: AgentConfig,
): AgentConfig {
  const both = (a: string[], b: string[]) => b.filter((x) => a.includes(x));
  if (parent.skillBundle !== child.skillBundle)
    throw new Fault(403, "SKILL_BUNDLE_MISMATCH");
  return {
    ...child,
    tools: both(parent.tools, child.tools) as AgentConfig["tools"],
    skills: both(parent.skills, child.skills),
    mcpServers: both(parent.mcpServers, child.mcpServers),
    subagents: both(parent.subagents, child.subagents),
    maxTokens: Math.min(parent.maxTokens, child.maxTokens),
    maxSteps: Math.min(parent.maxSteps, child.maxSteps),
    timeoutSeconds: Math.min(parent.timeoutSeconds, child.timeoutSeconds),
    maxDepth: Math.min(parent.maxDepth, child.maxDepth),
    maxSubagents: Math.min(parent.maxSubagents, child.maxSubagents),
  };
}

export function agentAllowed(v: AgentVersion, a: Actor) {
  return (
    v.enabled && (!v.allowedUsers?.length || v.allowedUsers.includes(a.userId))
  );
}
