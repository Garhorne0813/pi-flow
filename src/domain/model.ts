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
  issuer?: string;
  subject?: string;
  personal?: boolean;
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
  "web_search",
  "web_fetch",
] as const;
export const AgentConfig = z
  .object({
    name: z.string().min(1).max(100),
    systemPrompt: z.string().max(32000),
    agentsMd: z.array(z.string().max(32000)).default([]),
    model: z.union([
      z
        .literal("default")
        .transform(() => ({ provider: "default", modelId: "default" })),
      z
        .object({ provider: z.string().min(1), modelId: z.string().min(1) })
        .strict(),
    ]),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    tools: z.array(z.enum(tools)).max(12),
    skills: z.array(z.string()).default([]),
    mcpServers: z.array(z.string()).max(16).default([]),
    subagents: z.array(z.string()).default([]),
    subagentDefinitions: z.record(z.string(), z.unknown()).optional(),
    skillBundle: z.string().min(1).default("default"),
    approval: z
      .object({ mode: z.enum(["user", "guarded", "auto"]) })
      .strict()
      .optional(),
    userTokenAccess: z.boolean().optional(),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        scopes: z
          .array(z.enum(["user", "project"]))
          .default(["user", "project"]),
        maxFileBytes: z.number().int().min(100).max(262144).default(32000),
        maxTotalBytes: z.number().int().min(100).max(10000000).default(1000000),
        maxFiles: z.number().int().min(1).max(1000).default(100),
        maxIndexBytes: z.number().int().min(100).max(32000).default(8000),
        maxWritesPerRun: z.number().int().min(1).max(100).default(10),
      })
      .strict()
      .optional(),
    maxTokens: z.number().int().min(100).max(1000000).default(100000),
    maxSteps: z.number().int().min(1).max(100).default(30),
    timeoutSeconds: z.number().int().min(1).max(1800).default(600),
    maxSubagents: z.number().int().min(0).max(5).default(2),
    maxDepth: z.number().int().min(0).max(3).default(1),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfig>;
export type Agent = {
  id: string;
  activeVersionId: string;
  allowedUsers?: string[];
};
export const AgentDefaults = AgentConfig.pick({
  model: true,
  tools: true,
  skillBundle: true,
  maxTokens: true,
  maxSteps: true,
  timeoutSeconds: true,
  maxSubagents: true,
  maxDepth: true,
});
export type AgentDefaults = z.infer<typeof AgentDefaults>;
export type AgentVersion = {
  agentId?: string;
  id: string;
  config: AgentConfig;
  digest: string;
  publishedAt: string;
  enabled: boolean;
  allowedUsers?: string[]; // Legacy snapshot; logical Agent ACL governs access.
};
export type Workspace = {
  id: string;
  name: string;
  ownerId: string;
  members: Record<string, "owner" | "editor" | "viewer">;
  volumeId?: string;
  sandboxId?: string;
  sandboxSkillScope?: string; // Provider identity, including physical mounts.
  sandboxLogicalSkillScope?: string; // Bundle and immutable Skill identities.
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
  creationDigest?: string;
  id: string;
  workspaceId: string;
  userId?: string;
  agentId?: string;
  cwd?: string;
  title?: string;
  deletedAt?: string;
  effectiveVersionId?: string;
  /** Legacy shared-workspace sessions only. */
  agentVersionId?: string;
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
  userTokenRef?: string;
  memoryWrites?: number;
  memoryWriteReservations?: Record<string, { owner?: string }>;
  schedule?: {
    id: string;
    fireId: string;
    approvalMode: "deny" | "guarded" | "auto";
    allowedTools?: string[];
  };
  agentId?: string;
  agentVersionId?: string;
  configDigest?: string;
  cwd?: string;
  model?: AgentConfig["model"];
  /** Private execution reference; null pins the deployment gateway fallback. */
  modelGatewayRef?: string | null;
  taskId?: string;
  rootRunId?: string;
  eventSeq?: number;
  requestId?: string;
  traceparent?: string;
  startedAt?: string;
  endedAt?: string;
};
export type Event = {
  eventId: number;
  seq?: number;
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
  ossUpload?: {
    key: string;
    storageId: string;
    archiveDigest: string;
    files: number;
    bytes: number;
  };
  hostUpload?: {
    key: string;
    archiveDigest: string;
    files: number;
    bytes: number;
  };
  id: string;
  name: string;
  description: string;
  bundle: string;
  path: string;
  digest: string;
  enabled: boolean;
  versionDigest?: string;
  files?: Record<string, string>;
  disableModelInvocation?: boolean;
  subagentDefinitions?: Record<string, unknown>;
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
  modelCatalog?: import("../config/models.js").CatalogModel[];
  modelGatewayVersions?: Record<
    string,
    import("../config/models.js").ModelGateway
  >;
  modelSecretVersions?: Record<string, { ref: string; sealed: string }>;
  secrets?: Record<string, string>;
  configRevisions?: { global: number; agents: number };
  schedules?: Record<string, import("../schedules/service.js").ScheduledTask>;
  scheduleFires?: Record<string, import("../schedules/service.js").Fire>;
  managedAgents?: Record<string, ManagedAgent>;
  identities?: Record<
    string,
    { id: string; issuer: string; subject: string; enabled: boolean }
  >;
  policy?: { disabledTools: string[] };
  agentDefaults?: AgentDefaults;
  defaultsRevision?: number;
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
  if (["run.completed", "run.failed", "run.cancelled"].includes(type)) {
    r.endedAt = now;
    delete r.userTokenRef;
  }
  s.events.push({
    seq: (r.eventSeq = (r.eventSeq ?? 0) + 1),
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
  if (!v || v.deletedAt || (v.userId && v.userId !== a.userId))
    throw new Fault(404, "SESSION_NOT_FOUND");
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
    userTokenAccess: !!parent.userTokenAccess && !!child.userTokenAccess,
    approval:
      parent.approval || child.approval
        ? {
            mode:
              parent.approval?.mode === "user" ||
              !parent.approval ||
              child.approval?.mode === "user" ||
              !child.approval
                ? "user"
                : parent.approval.mode === "guarded" ||
                    child.approval.mode === "guarded"
                  ? "guarded"
                  : "auto",
          }
        : undefined,
    memory:
      parent.memory?.enabled && child.memory?.enabled
        ? {
            ...child.memory,
            scopes: child.memory.scopes.filter((s) =>
              parent.memory!.scopes.includes(s),
            ),
            maxFileBytes: Math.min(
              parent.memory.maxFileBytes,
              child.memory.maxFileBytes,
            ),
            maxTotalBytes: Math.min(
              parent.memory.maxTotalBytes,
              child.memory.maxTotalBytes,
            ),
            maxFiles: Math.min(parent.memory.maxFiles, child.memory.maxFiles),
            maxIndexBytes: Math.min(
              parent.memory.maxIndexBytes,
              child.memory.maxIndexBytes,
            ),
            maxWritesPerRun: Math.min(
              parent.memory.maxWritesPerRun,
              child.memory.maxWritesPerRun,
            ),
          }
        : undefined,
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

// Legacy records use the current active version only until ACL migration.
export function agentAllowed(
  v: Pick<AgentVersion, "enabled" | "allowedUsers"> & {
    id?: string;
    agentId?: string;
  },
  a: Actor,
  s?: State,
) {
  const logical =
    s && v.id && !s.managedAgents?.[v.id]
      ? s.logicalAgents[v.agentId ?? v.id]
      : undefined;
  const active = logical ? s!.agents[logical.activeVersionId] : undefined;
  if (logical && logical.allowedUsers === undefined && !active) return false;
  const users = logical
    ? (logical.allowedUsers ?? active?.allowedUsers)
    : v.allowedUsers;
  return v.enabled && (!users?.length || users.includes(a.userId));
}
export function logicalAgent(s: State, selector: string): Agent {
  const version = s.agents[selector];
  const key = version?.agentId ?? selector;
  let logical = s.logicalAgents[key];
  if (!logical) {
    if (!version) throw new Fault(404, "AGENT_NOT_FOUND");
    logical = s.logicalAgents[key] = { id: key, activeVersionId: version.id };
  }
  logical.allowedUsers ??= [
    ...(s.agents[logical.activeVersionId]?.allowedUsers ?? []),
  ];
  return logical;
}

export type ManagedAgent = {
  id: string;
  config: AgentConfig;
  enabled: boolean;
  allowedUsers?: string[];
  updatedAt: string;
};

export function taskRoot(s: State, r: Run): Run {
  if (r.rootRunId && s.runs[r.rootRunId]) return s.runs[r.rootRunId]!;
  let root = r;
  const seen = new Set<string>();
  while (root.parentRunId) {
    if (seen.has(root.id) || !s.runs[root.parentRunId])
      throw new Fault(409, "INVALID_RUN_TREE");
    seen.add(root.id);
    root = s.runs[root.parentRunId]!;
  }
  return root;
}
