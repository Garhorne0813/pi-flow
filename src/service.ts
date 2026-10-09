import { createHash } from "node:crypto";
import { skillScope } from "./adapters/skill-mounts.js";
import {
  Fault,
  id,
  event,
  audit,
  agentAllowed,
  session,
  run,
  workspace,
  admin,
  AgentConfig,
  intersect,
  type Actor,
  type State,
  type Run,
  type AgentVersion,
} from "./domain.js";
import type { Store } from "./store.js";
export const digest = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function createRun(
  s: State,
  a: Actor,
  sid: string,
  prompt: string,
  key?: string,
  extra: Partial<Run> = {},
): Run {
  const ses = session(s, a, sid, true);
  const av = s.agents[ses.agentVersionId];
  if (!av || !agentAllowed(av, a))
    throw new Fault(403, "AGENT_DISABLED_OR_DENIED");
  const hash = digest({ prompt });
  if (key) {
    const old = Object.values(s.runs).find(
      (r) =>
        r.sessionId === sid && r.actor.userId === a.userId && r.key === key,
    );
    if (old) {
      if (old.requestDigest !== hash)
        throw new Fault(409, "IDEMPOTENCY_CONFLICT");
      return old;
    }
  }
  if (
    Object.values(s.runs).some(
      (r) =>
        r.sessionId === sid &&
        !["COMPLETED", "FAILED", "CANCELLED"].includes(r.state),
    )
  )
    throw new Fault(409, "SESSION_BUSY");
  const r: Run = {
    id: id(),
    sessionId: sid,
    actor: a,
    prompt,
    state: "QUEUED",
    key,
    requestDigest: hash,
    createdAt: new Date().toISOString(),
    depth: 0,
    steps: 0,
    children: 0,
    ...extra,
  };
  s.runs[r.id] = r;
  event(s, r, "run.queued");
  audit(s, a, "run.create", r.id);
  return r;
}
export function authorizedRun(s: State, r: Run) {
  let current: Run | undefined = r;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) throw new Fault(403, "INVALID_RUN_TREE");
    seen.add(current.id);
    if (current.actor.expiresAt && current.actor.expiresAt <= Date.now())
      throw new Fault(401, "ACTOR_TOKEN_EXPIRED");
    const ses = session(s, current.actor, current.sessionId, true);
    if (
      !s.agents[ses.agentVersionId] ||
      !agentAllowed(s.agents[ses.agentVersionId]!, current.actor)
    )
      throw new Fault(403, "AGENT_REVOKED");
    if (current.cancelRequested || current.state === "CANCELLED")
      throw new Fault(409, "RUN_CANCELLED");
    current = current.parentRunId ? s.runs[current.parentRunId] : undefined;
  }
  const ses = s.sessions[r.sessionId]!;
  const config = r.capabilities ?? s.agents[ses.agentVersionId]!.config;
  for (const sk of config.skills) {
    if (!s.skills[sk]?.enabled) throw new Fault(403, "SKILL_REVOKED");
  }
  return { ses, config };
}
export class HarnessService {
  constructor(
    public store: Store,
    private endpointRefs: string[],
    private bundleRefs: string[],
    private models?: { provider: string; modelId: string }[],
    private grants?: Record<string, { bundles: string[]; endpoints: string[] }>,
  ) {}
  async publish(a: Actor, input: unknown) {
    admin(a);
    const config = AgentConfig.parse(input);
    if (
      this.models &&
      !this.models.some(
        (m) =>
          m.provider === config.model.provider &&
          m.modelId === config.model.modelId,
      )
    )
      throw new Fault(403, "MODEL_NOT_APPROVED");
    if (!this.hasBundle(config.skillBundle, a.tenantId))
      throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
    return this.store.tx(a.tenantId, (s) => {
      for (const key of config.skills) {
        const sk = s.skills[key];
        if (!sk?.enabled || sk.bundle !== config.skillBundle)
          throw new Fault(400, "INVALID_SKILL");
      }
      skillScope(
        config.skillBundle,
        config.skills.map((key) => s.skills[key]!),
      );
      for (const key of config.mcpServers)
        if (
          !s.mcp[key]?.enabled ||
          !this.hasEndpoint(s.mcp[key]!.endpointRef, a.tenantId)
        )
          throw new Fault(400, "INVALID_MCP");
      for (const key of config.subagents)
        if (!s.agents[key]?.enabled) throw new Fault(400, "INVALID_SUBAGENT");
      const av: AgentVersion = {
        id: id(),
        config,
        digest: digest(config),
        publishedAt: new Date().toISOString(),
        enabled: true,
      };
      s.agents[av.id] = av;
      audit(s, a, "agent.publish", av.id);
      return av;
    });
  }
  async createWorkspace(a: Actor, name: string) {
    return this.store.tx(a.tenantId, (s) => {
      const w = {
        id: id(),
        name,
        ownerId: a.userId,
        members: { [a.userId]: "owner" as const },
      };
      s.workspaces[w.id] = w;
      audit(s, a, "workspace.create", w.id);
      return w;
    });
  }
  async createSession(a: Actor, wid: string, avId: string) {
    return this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid, true);
      const av = s.agents[avId];
      if (!av || !agentAllowed(av, a)) throw new Fault(404, "AGENT_NOT_FOUND");
      if (!this.hasBundle(av.config.skillBundle, a.tenantId))
        throw new Fault(403, "BUNDLE_NOT_GRANTED");
      if (w.bundle && w.bundle !== av.config.skillBundle)
        throw new Fault(409, "SKILL_BUNDLE_MISMATCH");
      w.bundle = av.config.skillBundle;
      const ses = {
        id: id(),
        workspaceId: wid,
        agentVersionId: avId,
        entries: [],
        createdAt: new Date().toISOString(),
      };
      s.sessions[ses.id] = ses;
      audit(s, a, "session.create", ses.id);
      return ses;
    });
  }
  async submit(
    a: Actor,
    sid: string,
    prompt: string,
    key?: string,
    requestId?: string,
  ) {
    return this.store.tx(a.tenantId, (s) =>
      createRun(s, a, sid, prompt, key, { requestId }),
    );
  }
  async cancel(a: Actor, rid: string) {
    return this.store.tx(a.tenantId, (s) => {
      const r = run(s, a, rid, true);
      const cancel = (r: Run) => {
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(r.state)) return;
        r.cancelRequested = true;
        if (r.state !== "RUNNING") {
          r.state = "CANCELLED";
          event(s, r, "run.cancelled");
        }
        for (const child of Object.values(s.runs))
          if (child.parentRunId === r.id) cancel(child);
      };
      cancel(r);
      audit(s, a, "run.cancel", rid);
      return r;
    });
  }
  async respond(a: Actor, iid: string, response: string) {
    return this.store.tx(a.tenantId, (s) => {
      const i = s.interactions[iid];
      if (!i) throw new Fault(404, "INTERACTION_NOT_FOUND");
      const r = run(s, a, i.runId, true);
      if (i.resolved) {
        if (i.response !== response)
          throw new Fault(409, "INTERACTION_ALREADY_RESOLVED");
        return s.runs[i.continuationRunId!];
      }
      if (r.actor.userId !== a.userId)
        throw new Fault(403, "INTERACTION_ACTOR_REQUIRED");
      if (r.state !== "WAITING_INPUT") throw new Fault(409, "RUN_NOT_WAITING");
      if (r.lease) throw new Fault(409, "CHECKPOINT_PENDING");
      r.actor = a; // The same UCS subject may have refreshed its JWT while waiting.
      authorizedRun(s, r);
      if (i.kind === "approval" && !["approve", "deny"].includes(response))
        throw new Fault(400, "INVALID_APPROVAL");
      i.resolved = true;
      i.response = response;
      r.state = "COMPLETED";
      event(s, r, "interaction.resolved", { interactionId: iid });
      event(s, r, "run.completed", { reason: "continued" });
      const next = createRun(
        s,
        a,
        r.sessionId,
        i.kind === "question"
          ? `User response: ${response}`
          : `Approval decision: ${response}. Continue from the recorded tool result.`,
        undefined,
        {
          resumedFrom: iid,
          depth: r.depth,
          parentRunId: r.parentRunId,
          capabilities: r.capabilities,
          steps: r.steps,
          tokens: r.tokens,
          children: r.children,
          deadline: undefined,
        },
      );
      i.continuationRunId = next.id;
      return next;
    });
  }
  hasEndpoint(ref: string, tenant?: string) {
    return (
      this.endpointRefs.includes(ref) &&
      (!this.grants ||
        (!!tenant &&
          Object.hasOwn(this.grants, tenant) &&
          !!this.grants[tenant]?.endpoints.includes(ref)))
    );
  }
  hasBundle(ref: string, tenant?: string) {
    return (
      this.bundleRefs.includes(ref) &&
      (!this.grants ||
        (!!tenant &&
          Object.hasOwn(this.grants, tenant) &&
          !!this.grants[tenant]?.bundles.includes(ref)))
    );
  }
  async delegate(
    tenant: string,
    parentId: string,
    avId: string,
    task: string,
    owner: string,
  ) {
    return this.store.tx(tenant, (s) => {
      const p = s.runs[parentId]!;
      const { ses, config } = authorizedRun(s, p);
      if (!config.subagents.includes(avId))
        throw new Fault(403, "SUBAGENT_DENIED");
      const child = s.agents[avId];
      if (!child || !agentAllowed(child, p.actor))
        throw new Fault(403, "SUBAGENT_REVOKED");
      if (p.depth >= config.maxDepth || p.children >= config.maxSubagents)
        throw new Fault(429, "SUBAGENT_LIMIT");
      let root = p;
      while (root.parentRunId) root = s.runs[root.parentRunId]!;
      const rootConfig =
        root.capabilities ??
        s.agents[s.sessions[root.sessionId]!.agentVersionId]!.config;
      if (root.id !== p.id && root.children >= rootConfig.maxSubagents)
        throw new Fault(429, "SUBAGENT_LIMIT");
      p.children++;
      if (root.id !== p.id) root.children++;
      const effective = intersect(config, child.config);
      const sid = id();
      s.sessions[sid] = {
        id: sid,
        workspaceId: ses.workspaceId,
        agentVersionId: avId,
        entries: [],
        createdAt: new Date().toISOString(),
      };
      const r = createRun(s, p.actor, sid, task, undefined, {
        parentRunId: p.id,
        depth: p.depth + 1,
        capabilities: effective,
        deadline: p.deadline,
      });
      r.state = "RUNNING";
      r.lease = { owner, expires: Date.now() + 30000 };
      event(s, p, "subagent.started", { childRunId: r.id });
      event(s, r, "run.started");
      return r;
    });
  }
}
