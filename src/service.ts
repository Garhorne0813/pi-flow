import { sealToken } from "./security/token-vault.js";
import { createHash } from "node:crypto";
import { skillScope, skillIdentityScope } from "./adapters/skill-mounts.js";
import {
  Fault,
  id,
  event,
  audit,
  agentAllowed,
  logicalAgent,
  session,
  run,
  workspace,
  admin,
  AgentConfig,
  intersect,
  terminal,
  taskRoot,
  type Actor,
  type State,
  type Run,
  type AgentVersion,
  type Skill,
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
  if (a.personal || s.sessions[sid]?.userId)
    return createPersonalRun(s, a, sid, prompt, key, extra);
  const ses = session(s, a, sid, true);
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
  if (!extra.parentRunId && !extra.resumedFrom)
    expireRevokedWaitingTasks(s, a, ses.workspaceId);
  if (
    Object.values(s.runs).some(
      (r) =>
        r.sessionId === sid &&
        !["COMPLETED", "FAILED", "CANCELLED"].includes(r.state),
    )
  )
    throw new Fault(409, "SESSION_BUSY");
  const inherited = !!(extra.resumedFrom || extra.parentRunId);
  const agentId =
    ses.agentId ??
    s.agents[ses.agentVersionId ?? ""]?.agentId ??
    ses.agentVersionId;
  const versionId = inherited
    ? (extra.agentVersionId ?? ses.agentVersionId)
    : (s.logicalAgents[agentId ?? ""]?.activeVersionId ?? ses.agentVersionId);
  const av = s.agents[versionId ?? ""];
  if (!av || !agentAllowed(av, a, s))
    throw new Fault(403, "AGENT_DISABLED_OR_DENIED");
  const config = extra.capabilities ?? av.config;
  validateConfig(s, config);
  const w = s.workspaces[ses.workspaceId]!;
  if (w.bundle && w.bundle !== config.skillBundle)
    throw new Fault(
      409,
      "WORKSPACE_BUNDLE_MIGRATION_REQUIRED",
      "Create a Workspace for the new skillBundle; automatic bundle migration is unsupported.",
    );
  if (!inherited) {
    const scope = skillScope(
      config.skillBundle,
      config.skills.map((k) => s.skills[k]!),
    );
    for (const other of Object.values(s.runs)) {
      if (
        terminal(other.state) ||
        s.sessions[other.sessionId]?.workspaceId !== w.id
      )
        continue;
      const otherConfig =
        other.capabilities ??
        s.agents[
          other.agentVersionId ??
            s.sessions[other.sessionId]!.agentVersionId ??
            ""
        ]?.config;
      if (
        !otherConfig ||
        otherConfig.skills.some((k) => !s.skills[k]) ||
        skillIdentityScope(
          otherConfig.skillBundle,
          otherConfig.skills.map((k) => s.skills[k]!),
        ) !== scope
      )
        throw new Fault(
          409,
          "WORKSPACE_VERSION_BUSY",
          "Retry after the incompatible Workspace task finishes.",
        );
    }
    if (w.lock && w.lock.expires > Date.now()) {
      // Provider scopes also hash mount sources. Compare only logical skill
      // identities here; the provider checks physical mount compatibility when
      // the tool lease is acquired. Derive legacy records without rewriting them.
      const mountedSkills = w.sandboxSkills?.map((key) => s.skills[key]);
      const mountedScope =
        w.sandboxLogicalSkillScope ??
        (mountedSkills?.every((sk) => sk?.enabled && sk.bundle === w.bundle)
          ? skillScope(w.bundle!, mountedSkills as Skill[])
          : undefined);
      if (mountedScope !== scope) throw new Fault(409, "WORKSPACE_BUSY");
    }
    // A terminal root Run can still have an unfinished descendant/continuation.
    if (
      Object.values(s.runs).some(
        (other) =>
          !terminal(other.state) &&
          s.runs[other.rootRunId ?? other.id]?.sessionId === sid,
      )
    )
      throw new Fault(409, "SESSION_BUSY");
  }
  const runId = id();
  const r: Run = {
    id: runId,
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
    agentVersionId: versionId,
    capabilities: structuredClone(config),
    taskId: extra.taskId ?? runId,
    rootRunId: extra.rootRunId ?? runId,
  };
  s.runs[r.id] = r;
  if (!inherited) {
    const from = ses.effectiveVersionId ?? ses.agentVersionId;
    ses.agentId = agentId;
    ses.agentVersionId = ses.effectiveVersionId = versionId;
    if (from !== versionId) {
      const upgrade = {
        from,
        to: versionId,
        actor: a.userId,
        reason: "new_root_task",
        timestamp: r.createdAt,
      };
      event(s, r, "session.version.upgraded", upgrade);
      audit(s, a, "session.version.upgraded", ses.id, JSON.stringify(upgrade));
    }
  }
  event(s, r, "run.queued");
  audit(s, a, "run.create", r.id);
  return r;
}
function createPersonalRun(
  s: State,
  a: Actor,
  sid: string,
  prompt: string,
  key?: string,
  extra: Partial<Run> = {},
): Run {
  const ses = session(s, a, sid, true);
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
  const agentId = extra.agentId ?? ses.agentId;
  const av = agentId
    ? s.managedAgents?.[agentId]
    : s.agents[extra.agentVersionId ?? ses.agentVersionId ?? ""];
  if (!av || !agentAllowed(av, a))
    throw new Fault(403, "AGENT_DISABLED_OR_DENIED");
  const config = extra.capabilities ?? av.config;
  validateConfig(s, config);
  let model = extra.model ?? config.model;
  const catalog = s.modelCatalog ?? [];
  if (model.provider === "default") {
    if (catalog.length) {
      const selected = catalog.find((m) => m.default);
      if (!selected) throw new Fault(503, "DEFAULT_MODEL_UNAVAILABLE");
      model = { provider: selected.provider, modelId: selected.modelId };
    } else if (process.env.HARNESS_MODE === "demo")
      model = { provider: "demo", modelId: "demo" };
    else if (process.env.LLM_PROVIDER && process.env.LLM_MODEL_ID)
      model = {
        provider: process.env.LLM_PROVIDER,
        modelId: process.env.LLM_MODEL_ID,
      };
    else throw new Fault(503, "DEFAULT_MODEL_UNAVAILABLE");
  }
  const selected = catalog.find(
    (m) => m.provider === model.provider && m.modelId === model.modelId,
  );
  const inheritedGateway = extra.modelGatewayRef !== undefined;
  if (!inheritedGateway && catalog.length && !selected)
    throw new Fault(403, "MODEL_NOT_APPROVED");
  if (!inheritedGateway && selected && !selected.gatewayRef)
    throw new Fault(503, "MODEL_GATEWAY_UNVERSIONED");
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
    agentId,
    ...(agentId ? {} : { agentVersionId: av.id }),
    configDigest: digest({ ...config, model }),
    model: structuredClone(model),
    modelGatewayRef: selected?.gatewayRef ?? null,
    capabilities: structuredClone({ ...config, model }),
    cwd: ses.cwd ?? "/workspace",
    ...extra,
  };
  r.taskId ??= r.id;
  r.rootRunId ??= r.id;
  s.runs[r.id] = r;
  event(s, r, "run.queued");
  audit(s, a, "run.create", r.id);
  return r;
}
export function runConfig(s: State, r: Run): AgentConfig {
  if (r.capabilities) return r.capabilities;
  const ses = s.sessions[r.sessionId],
    agentId = r.agentId ?? ses?.agentId;
  // Personal Runs must carry their own snapshot; only the legacy engine can
  // resolve a missing snapshot through its historical AgentVersion reference.
  if (agentId && s.managedAgents?.[agentId])
    throw new Fault(409, "RUN_CONFIG_MISSING");
  const config =
    s.agents[r.agentVersionId ?? ses?.agentVersionId ?? ""]?.config;
  if (!config) throw new Fault(409, "RUN_CONFIG_MISSING");
  return config;
}
export function validateConfig(s: State, config: AgentConfig) {
  skillScope(
    config.skillBundle,
    config.skills.map((key) => {
      const skill = s.skills[key];
      if (!skill?.enabled) throw new Fault(403, "SKILL_REVOKED");
      return skill;
    }),
  );
  for (const key of config.mcpServers)
    if (!s.mcp[key]?.enabled) throw new Fault(403, "MCP_REVOKED");
}
export function taskIdentity(s: State, r: Run): string {
  if (r.taskId || r.rootRunId) return (r.taskId ?? r.rootRunId)!;
  const seen = new Set<string>();
  let current = r;
  while (true) {
    if (seen.has(current.id)) throw new Fault(403, "INVALID_RUN_TREE");
    seen.add(current.id);
    const predecessor =
      current.parentRunId ??
      (current.resumedFrom
        ? s.interactions[current.resumedFrom]?.runId
        : undefined);
    if (!predecessor || !s.runs[predecessor]) return current.id;
    current = s.runs[predecessor]!;
    if (current.taskId || current.rootRunId)
      return (current.taskId ?? current.rootRunId)!;
  }
}
function expireRevokedWaitingTasks(s: State, a: Actor, wid: string) {
  for (const r of Object.values(s.runs)) {
    if (
      r.state !== "WAITING_INPUT" ||
      r.lease ||
      s.sessions[r.sessionId]?.workspaceId !== wid
    )
      continue;
    try {
      // Waiting subjects can refresh their JWT; expiry alone is not revocation.
      authorizedRun(s, r, { ignoreActorExpiry: true });
    } catch (e) {
      if (
        !(e instanceof Fault) ||
        ![
          "AGENT_REVOKED",
          "SKILL_REVOKED",
          "MCP_REVOKED",
          "SKILL_DENIED",
          "WORKSPACE_NOT_FOUND",
          "READ_ONLY",
        ].includes(e.code)
      )
        continue;
      const taskId = taskIdentity(s, r);
      for (const member of Object.values(s.runs)) {
        if (terminal(member.state) || taskIdentity(s, member) !== taskId)
          continue;
        member.error = e.code;
        if (member.state === "RUNNING" || member.lease) {
          member.cancelRequested = true;
          event(s, member, "task.revoked", { taskId, code: e.code });
        } else {
          member.state = "FAILED";
          event(s, member, "run.failed", {
            taskId,
            code: e.code,
            reason: "task_revoked",
          });
        }
        audit(s, a, "task.revoked", taskId, e.code);
      }
    }
  }
}
export function authorizedRun(
  s: State,
  r: Run,
  options: { ignoreActorExpiry?: boolean } = {},
) {
  let current: Run | undefined = r;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) throw new Fault(403, "INVALID_RUN_TREE");
    seen.add(current.id);
    if (
      !options.ignoreActorExpiry &&
      current.actor.expiresAt &&
      current.actor.expiresAt <= Date.now()
    )
      throw new Fault(401, "ACTOR_TOKEN_EXPIRED");
    const ses = session(s, current.actor, current.sessionId, true);
    const managed = s.managedAgents?.[current.agentId ?? ses.agentId ?? ""];
    const live =
      current.actor.personal || ses.userId
        ? managed
        : s.agents[current.agentVersionId ?? ses.agentVersionId ?? ""];
    if (!live || !agentAllowed(live, current.actor, s))
      throw new Fault(403, "AGENT_REVOKED");
    if (current.cancelRequested || current.state === "CANCELLED")
      throw new Fault(409, "RUN_CANCELLED");
    current = current.parentRunId ? s.runs[current.parentRunId] : undefined;
  }
  const ses = s.sessions[r.sessionId]!;
  const config = runConfig(s, r);
  validateConfig(s, config);
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
  async verifyActor(_a: Actor): Promise<void> {}
  async publish(a: Actor, input: unknown, agentId?: string) {
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
      const logical = agentId
        ? logicalAgent(s, agentId)
        : { id: id(), activeVersionId: "", allowedUsers: [] };
      const logicalId = logical.id;
      const av: AgentVersion = {
        agentId: logicalId,
        id: id(),
        config,
        digest: digest(config),
        publishedAt: new Date().toISOString(),
        enabled: true,
      };
      s.agents[av.id] = av;
      logical.activeVersionId = av.id;
      s.logicalAgents[logicalId] = logical;
      audit(s, a, "agent.publish", av.id);
      return av;
    });
  }
  async activate(a: Actor, agentId: string, versionId: string) {
    admin(a);
    return this.store.tx(a.tenantId, (s) => {
      const av = s.agents[versionId ?? ""];
      if (!av || (av.agentId ?? av.id) !== agentId || !av.enabled)
        throw new Fault(400, "INVALID_AGENT_VERSION");
      validateConfig(s, av.config);
      if (!this.hasBundle(av.config.skillBundle, a.tenantId))
        throw new Fault(403, "BUNDLE_NOT_GRANTED");
      for (const key of av.config.mcpServers)
        if (!this.hasEndpoint(s.mcp[key]!.endpointRef, a.tenantId))
          throw new Fault(403, "MCP_ENDPOINT_NOT_GRANTED");
      const logical = logicalAgent(s, agentId);
      logical.activeVersionId = versionId;
      audit(s, a, "agent.activate", agentId, versionId);
      return s.logicalAgents[agentId ?? ""];
    });
  }
  async setAccess(a: Actor, selector: string, allowedUsers: string[]) {
    admin(a);
    return this.store.tx(a.tenantId, (s) => {
      const logical = logicalAgent(s, selector);
      logical.allowedUsers = [...allowedUsers];
      audit(s, a, "agent.access", logical.id);
      return { allowedUsers: logical.allowedUsers };
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
      const logicalId = s.agents[avId]?.agentId ?? avId;
      const av = s.agents[s.logicalAgents[logicalId]?.activeVersionId ?? avId];
      if (!av || !agentAllowed(av, a, s))
        throw new Fault(404, "AGENT_NOT_FOUND");
      if (!this.hasBundle(av.config.skillBundle, a.tenantId))
        throw new Fault(403, "BUNDLE_NOT_GRANTED");
      if (w.bundle && w.bundle !== av.config.skillBundle)
        throw new Fault(409, "SKILL_BUNDLE_MISMATCH");
      w.bundle = av.config.skillBundle;
      const ses = {
        id: id(),
        workspaceId: wid,
        agentId: logicalId,
        agentVersionId: av.id,
        effectiveVersionId: av.id,
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
    traceparent?: string,
    bearerToken?: string,
  ) {
    const transact =
      a.personal && this.store.txLight
        ? <T>(fn: (s: State) => T | Promise<T>) =>
            this.store.txLight!(a.tenantId, sid, fn, key)
        : <T>(fn: (s: State) => T | Promise<T>) =>
            this.store.tx(a.tenantId, fn);
    return transact((s) => {
      const existing =
        key &&
        Object.values(s.runs).some(
          (r) =>
            r.sessionId === sid && r.actor.userId === a.userId && r.key === key,
        );
      const r = createRun(s, a, sid, prompt, key, { requestId, traceparent });
      if (existing) return r;
      if (
        r.capabilities?.userTokenAccess &&
        !r.userTokenRef &&
        r.state === "QUEUED"
      ) {
        if (!bearerToken) throw new Fault(401, "USER_TOKEN_REQUIRED");
        r.userTokenRef = sealToken(
          bearerToken,
          r.actor.userId + ":" + r.taskId,
        );
      }
      const config = r.capabilities!;
      if (!this.hasBundle(config.skillBundle, a.tenantId))
        throw new Fault(403, "BUNDLE_NOT_GRANTED");
      for (const key of config.mcpServers)
        if (!this.hasEndpoint(s.mcp[key]!.endpointRef, a.tenantId))
          throw new Fault(403, "MCP_ENDPOINT_NOT_GRANTED");
      return r;
    });
  }
  async cancel(a: Actor, rid: string) {
    const transact = this.store.cancelTaskTx
      ? <T>(fn: (s: State) => T | Promise<T>) =>
          this.store.cancelTaskTx!(a.tenantId, rid, fn)
      : <T>(fn: (s: State) => T | Promise<T>) => this.store.tx(a.tenantId, fn);
    return transact((s) => {
      const r = run(s, a, rid, true);
      const taskId = taskIdentity(s, r);
      for (const member of Object.values(s.runs)) {
        if (terminal(member.state) || taskIdentity(s, member) !== taskId)
          continue;
        member.cancelRequested = true;
        if (member.state !== "RUNNING") {
          member.state = "CANCELLED";
          event(s, member, "run.cancelled", { taskId });
        }
      }
      audit(s, a, "run.cancel", rid);
      return r;
    });
  }
  async respond(a: Actor, iid: string, response: string, bearerToken?: string) {
    const transact = this.store.interactionTx
      ? <T>(fn: (s: State) => T | Promise<T>) =>
          this.store.interactionTx!(a.tenantId, iid, fn)
      : <T>(fn: (s: State) => T | Promise<T>) => this.store.tx(a.tenantId, fn);
    return transact((s) => {
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
      if (i.kind === "approval" && !["approve", "deny"].includes(response))
        throw new Fault(400, "INVALID_APPROVAL");
      const taskId = taskIdentity(s, r);
      const members = Object.values(s.runs).filter(
        (member) =>
          !terminal(member.state) &&
          member.actor.userId === a.userId &&
          member.actor.tenantId === a.tenantId &&
          taskIdentity(s, member) === taskId,
      );
      // Authentication may have been refreshed while this task was waiting.
      // Update only this caller's unfinished task chain; config snapshots stay
      // unchanged. Failed authorization rolls back the entire transaction.
      for (const member of members) member.actor = structuredClone(a);
      const { config } = authorizedRun(s, r);
      const tokenMembers = members.filter(
        (member) => runConfig(s, member).userTokenAccess,
      );
      let userTokenRef: string | undefined;
      if (tokenMembers.length) {
        if (!bearerToken) throw new Fault(401, "USER_TOKEN_REQUIRED");
        const sealed = sealToken(bearerToken, a.userId + ":" + taskId);
        for (const member of tokenMembers) member.userTokenRef = sealed;
        if (config.userTokenAccess) userTokenRef = sealed;
        audit(s, a, "task.token.refresh", taskId);
      }
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
          userTokenRef,
          schedule: r.schedule,
          agentId: r.agentId ?? s.sessions[r.sessionId]!.agentId,
          agentVersionId: r.agentVersionId,
          configDigest: r.configDigest,
          model: r.model,
          modelGatewayRef: r.modelGatewayRef,
          cwd: r.cwd,
          taskId,
          rootRunId: r.rootRunId ?? taskId,
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
  adminConfiguration(a: Actor) {
    admin(a);
    return {
      models: this.models ?? [],
      bundles: this.bundleRefs.filter((ref) => this.hasBundle(ref, a.tenantId)),
      endpoints: this.endpointRefs.filter((ref) =>
        this.hasEndpoint(ref, a.tenantId),
      ),
      modelApprovalRequired: this.models !== undefined,
    };
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
    const transact = <T>(fn: (s: State) => T | Promise<T>) =>
      this.store.executionTx
        ? this.store.executionTx(tenant, parentId, fn)
        : this.store.tx(tenant, fn);
    return transact((s) => {
      const p = s.runs[parentId]!;
      const { ses, config } = authorizedRun(s, p);
      const requestedKey = avId;
      const inline = config.subagentDefinitions?.[avId];
      const skillMatch = /^skill:([^:]+):([^:]+)$/.exec(avId);
      const skillDef =
        skillMatch && config.skills.includes(skillMatch[1]!)
          ? s.skills[skillMatch[1]!]
          : undefined;
      const definition =
        inline ?? skillDef?.subagentDefinitions?.[skillMatch![2]!];
      if (!definition && !config.subagents.includes(requestedKey))
        throw new Fault(403, "SUBAGENT_DENIED");
      let child:
        | {
            id: string;
            config: AgentConfig;
            enabled: boolean;
            allowedUsers?: string[];
            agentId?: string;
          }
        | undefined = s.managedAgents?.[avId] ?? s.agents[avId];
      if (definition) {
        const childConfig = AgentConfig.parse({
          ...config,
          ...(definition as object),
          subagents: [],
          subagentDefinitions: {},
        });
        child = { id: avId, config: childConfig, enabled: true };
      } else avId = child?.id ?? avId;
      if (!child || !agentAllowed(child, p.actor, s))
        throw new Fault(403, "SUBAGENT_REVOKED");
      if (p.depth >= config.maxDepth || p.children >= config.maxSubagents)
        throw new Fault(429, "SUBAGENT_LIMIT");
      const root = taskRoot(s, p);
      const rootConfig = runConfig(s, root);
      if (root.id !== p.id && root.children >= rootConfig.maxSubagents)
        throw new Fault(429, "SUBAGENT_LIMIT");
      p.children++;
      if (root.id !== p.id) root.children++;
      const effective = intersect(config, child.config);
      if (p.actor.personal || ses.userId) {
        effective.tools = effective.tools.filter(
          (t) => t !== "delegate_to_agent",
        );
        effective.subagents = [];
        effective.maxDepth = 0;
      }
      const sid = id();
      s.sessions[sid] = {
        id: sid,
        workspaceId: ses.workspaceId,
        userId: ses.userId,
        cwd: ses.cwd,
        agentId: ses.userId
          ? definition
            ? (p.agentId ?? ses.agentId)
            : avId
          : (child.agentId ?? child.id),
        agentVersionId: ses.userId
          ? undefined
          : definition
            ? (p.agentVersionId ?? ses.agentVersionId)
            : avId,
        entries: [],
        createdAt: new Date().toISOString(),
      };
      const r = createRun(s, p.actor, sid, task, undefined, {
        parentRunId: p.id,
        schedule: p.schedule,
        userTokenRef: p.userTokenRef,
        ...(effective.model.provider === config.model.provider &&
        effective.model.modelId === config.model.modelId
          ? { model: p.model, modelGatewayRef: p.modelGatewayRef }
          : {}),
        taskId: p.taskId ?? p.id,
        rootRunId: p.rootRunId ?? p.id,
        agentId: ses.userId
          ? definition
            ? (p.agentId ?? ses.agentId)
            : avId
          : undefined,
        agentVersionId: ses.userId
          ? undefined
          : definition
            ? (p.agentVersionId ?? ses.agentVersionId)
            : avId,
        depth: p.depth + 1,
        capabilities: effective,
        deadline: Math.min(
          p.deadline ?? Infinity,
          Date.now() + effective.timeoutSeconds * 1000,
        ),
      });
      r.state = "RUNNING";
      r.lease = { owner, expires: Date.now() + 30000 };
      event(s, p, "subagent.started", { childRunId: r.id });
      event(s, r, "run.started");
      return r;
    });
  }
}
