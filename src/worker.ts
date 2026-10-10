import {
  id,
  Fault,
  event,
  audit,
  terminal,
  type Run,
  type State,
  type AgentConfig,
} from "./domain.js";
import { HarnessService, authorizedRun } from "./service.js";
import type { Runtime } from "./runtime.js";
import type { SandboxManager } from "./adapters/sandbox.js";
import type { MCPManager, McpCallContext } from "./adapters/mcp.js";
import { UsageLedger, policyFromEnv } from "./usage.js";
import { argumentsSchemas, specs } from "./tool-specs.js";
import { telemetry, traceContext, withContext } from "./telemetry.js";
import { bounded, type WorkerHealth } from "./health.js";
export class Worker {
  readonly owner = id();
  private stopping = false;
  private ledger: UsageLedger;
  private active = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  private maintenance?: Promise<unknown>;
  private lastTenant?: string;
  private tickTail: Promise<void> = Promise.resolve();
  private lastMetricPublish = 0;
  private health: WorkerHealth = {
    workerId: this.owner,
    heartbeatAt: 0,
    activeTasks: 0,
    stopping: false,
    maintenance: "pending",
  };
  private lastHealthWrite = 0;
  private async publishHealth(force = false) {
    if (!force && Date.now() - this.lastHealthWrite < 5000) return;
    this.health.heartbeatAt = Date.now();
    this.health.activeTasks = this.active.size;
    this.health.stopping = this.stopping;
    await bounded(this.service.store.workerHeartbeat(this.health));
    this.lastHealthWrite = Date.now();
  }
  constructor(
    private service: HarnessService,
    private runtime: Runtime,
    private sandbox: SandboxManager,
    private mcp: MCPManager,
    private concurrency = 4,
    private shutdownTimeoutMs = 5000,
  ) {
    this.ledger = new UsageLedger(service.store, policyFromEnv());
    if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0)
      throw new Error("Invalid Worker shutdown timeout");
  }
  tick() {
    const task = this.tickTail.then(async () => {
      try {
        await this.tickOnce();
        this.health.lastSuccessfulTick = Date.now();
      } finally {
        await this.publishHealth();
      }
    });
    this.tickTail = task.catch((e) => {
      telemetry.error("worker_tick", e, { workerId: this.owner });
    });
    return task;
  }
  private async tickOnce() {
    if (this.stopping) return;
    if (Date.now() - this.lastMetricPublish >= 5000) {
      telemetry.publish(this.owner);
      this.lastMetricPublish = Date.now();
    }
    if (!this.maintenance) {
      const task = this.sandbox
        .sweepIfDue()
        .then((result) => {
          this.health.maintenance = result?.failed ? "failed" : "ok";
          if (result?.failed) {
            telemetry.count("sandbox_reclaim_failed_total", result.failed);
            telemetry.error(
              "maintenance",
              new Fault(503, "SANDBOX_RECLAIM_FAILED"),
              { workerId: this.owner },
            );
          }
        })
        .catch((e) => {
          this.health.maintenance = "failed";
          telemetry.error("maintenance", e, { workerId: this.owner });
        });
      this.maintenance = task;
      void task.finally(() => {
        if (this.maintenance === task) this.maintenance = undefined;
      });
    }
    const tenants = (await this.service.store.tenants()).sort();
    let start =
      this.lastTenant === undefined
        ? 0
        : tenants.findIndex((t) => t > this.lastTenant!);
    if (start < 0) start = 0;
    for (let i = 0; i < tenants.length; i++) {
      const tenant = tenants[(start + i) % tenants.length]!;
      if (this.stopping || this.active.size >= this.concurrency) break;
      this.lastTenant = tenant;
      // Idle scans are snapshots; claiming/recovering still rechecks under tx.
      const pending = await this.service.store.read(tenant, (s) =>
        Object.values(s.runs).some(
          (r) =>
            r.state === "QUEUED" || (r.lease && r.lease.expires < Date.now()),
        ),
      );
      if (!pending) continue;
      const r = await this.service.store.tx(tenant, (s) => {
        for (const old of Object.values(s.runs)) {
          if (old.lease && old.lease.expires < Date.now()) {
            delete old.lease;
            if (old.state === "RUNNING") {
              old.state = "FAILED";
              old.error = "WORKER_LOST_UNKNOWN_TOOL_OUTCOME";
              event(s, old, "run.failed", { code: old.error });
            }
          }
        }
        const r = Object.values(s.runs).find((r) => r.state === "QUEUED");
        if (!r) return;
        try {
          const { config } = authorizedRun(s, r);
          r.deadline ??= Date.now() + config.timeoutSeconds * 1000;
          r.state = "RUNNING";
          r.lease = { owner: this.owner, expires: Date.now() + 30000 };
          event(s, r, "run.started");
          return r;
        } catch (e) {
          r.state = "FAILED";
          r.error = e instanceof Fault ? e.code : "AUTHORIZATION_FAILED";
          event(s, r, "run.failed", { code: r.error });
          return;
        }
      });
      if (r) {
        this.health.lastClaimAt = Date.now();
        telemetry.duration("run_queue", Date.now() - Date.parse(r.createdAt));
        const p = withContext(
          {
            tenantId: tenant,
            runId: r.id,
            workerId: this.owner,
            requestId: r.requestId,
            ...traceContext(r.traceparent),
          },
          () => this.execute(tenant, r),
        ).catch((e) => {
          telemetry.error("execute_unhandled", e, {
            tenantId: tenant,
            runId: r.id,
            workerId: this.owner,
            requestId: r.requestId,
          });
        });
        this.active.add(p);
        void p.finally(() => this.active.delete(p));
      }
    }
  }
  async start() {
    while (!this.stopping) {
      await this.tick().catch(() => this.tickTail);
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.stop();
  }
  async stop() {
    this.stopping = true;
    for (const c of this.controllers) c.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.tickTail;
          // A tick already claiming a Run may register its controller after
          // the first abort pass; drain those controllers as well.
          for (const c of this.controllers) c.abort();
          await Promise.all(this.active);
          await this.maintenance;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Fault(503, "WORKER_SHUTDOWN_UNSETTLED")),
            this.shutdownTimeoutMs,
          );
        }),
      ]);
    } catch (e) {
      telemetry.error("shutdown", e, { workerId: this.owner });
      throw e;
    } finally {
      clearTimeout(timer);
      await this.publishHealth(true);
    }
  }
  private owned(s: State, rid: string) {
    const r = s.runs[rid];
    if (!r || r.lease?.owner !== this.owner || r.lease.expires < Date.now())
      throw new Fault(409, "LEASE_LOST");
    return r;
  }
  async execute(tenant: string, initial: Run): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    this.controllers.add(controller);
    let waiting = false;
    let fault: string | undefined;
    const timeout = setTimeout(
      () => {
        fault = "RUN_TIMEOUT";
        controller.abort();
      },
      Math.max(0, (initial.deadline ?? Date.now() + 600000) - Date.now()),
    );
    const heartbeat = setInterval(() => {
      void this.service.store
        .tx(tenant, (s) => {
          const r = this.owned(s, initial.id);
          authorizedRun(s, r);
          if ((r.deadline ?? 0) < Date.now())
            throw new Fault(408, "RUN_TIMEOUT");
          r.lease!.expires = Date.now() + 30000;
        })
        .catch((e) => {
          telemetry.error("heartbeat", e, {
            tenantId: tenant,
            runId: initial.id,
            workerId: this.owner,
          });
          fault = e instanceof Fault ? e.code : "HEARTBEAT_FAILED";
          controller.abort();
        });
    }, 1000);
    const emit = (type: string, data: unknown) =>
      this.service.store.tx(tenant, (s) => {
        const r = this.owned(s, initial.id);
        event(s, r, type, data);
      });
    const get = () =>
      this.service.store.read(tenant, (s) => {
        const r = this.owned(s, initial.id);
        const { ses, config } = authorizedRun(s, r);
        if (!this.service.hasBundle(config.skillBundle, r.actor.tenantId))
          throw new Fault(403, "BUNDLE_NOT_GRANTED");
        return {
          r,
          ses,
          config,
          skills: config.skills.map((k) => s.skills[k]!),
        };
      });
    const defer = async (kind: "question" | "approval", payload: unknown) => {
      if (initial.parentRunId)
        throw new Fault(409, "SUBAGENT_INTERACTION_UNSUPPORTED");
      await this.service.store.tx(tenant, (s) => {
        const r = this.owned(s, initial.id);
        authorizedRun(s, r);
        const i = { id: id(), runId: r.id, kind, payload, resolved: false };
        s.interactions[i.id] = i;
        r.state = "WAITING_INPUT";
        event(s, r, "interaction.required", { interaction: i });
      });
      waiting = true;
      controller.abort();
      throw new Fault(409, "INTERACTION_PENDING");
    };
    const executeTool = async (
      name: string,
      args: Record<string, unknown>,
      config: AgentConfig,
      wid: string,
      mcpCall: (
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
        context?: McpCallContext,
      ) => Promise<unknown>,
      mcpAuthorize: (name: string) => Promise<void>,
      approved = false,
    ): Promise<unknown> => {
      controller.signal.throwIfAborted();
      const bare = name.replace(/^remote_/, "");
      const mcpTool = name.startsWith("mcp_");
      if (
        !mcpTool &&
        !config.tools.includes(bare as AgentConfig["tools"][number])
      )
        throw new Fault(403, "TOOL_DENIED");
      if (!mcpTool) args = argumentsSchemas[bare]!.parse(args);
      else await mcpAuthorize(name);
      if (!approved && (mcpTool || ["write", "edit", "bash"].includes(bare)))
        return defer("approval", { name, args });
      const callId = id();
      await this.service.store.tx(tenant, (s) => {
        const r = this.owned(s, initial.id);
        const { config } = authorizedRun(s, r);
        let root = r;
        while (root.parentRunId) root = s.runs[root.parentRunId]!;
        const rc =
          root.capabilities ??
          s.agents[s.sessions[root.sessionId]!.agentVersionId]!.config;
        if (r.steps >= config.maxSteps || root.steps >= rc.maxSteps)
          throw new Fault(429, "STEP_BUDGET_EXCEEDED");
        r.steps++;
        if (root.id !== r.id) root.steps++;
        event(s, r, "tool.started", { name, callId });
        audit(s, r.actor, "tool.execute", name);
      });
      try {
        let result: unknown;
        if (mcpTool)
          result = await mcpCall(name, args, controller.signal, {
            callId,
            runId: initial.id,
            requestId: initial.requestId,
            event: (phase) =>
              emit(`tool.${phase}`, {
                name,
                callId,
                runId: initial.id,
                requestId: initial.requestId,
              }),
          });
        else if (bare === "ask_user_question")
          return await defer("question", { question: args.question });
        else if (bare === "todo") {
          await this.service.store.tx(tenant, (s) => {
            const r = this.owned(s, initial.id);
            s.todos[r.sessionId] = args.items;
            event(s, r, "todo.updated", { items: args.items });
          });
          result = { saved: true };
        } else if (bare === "delegate_to_agent") {
          const child = await this.service.delegate(
            tenant,
            initial.id,
            String(args.agentVersionId),
            String(args.task),
            this.owner,
          );
          await this.execute(tenant, child);
          result = await this.service.store.tx(tenant, (s) => {
            const cr = s.runs[child.id]!;
            const messages = s.events
              .filter(
                (e) => e.runId === cr.id && e.type === "message.completed",
              )
              .map((e) => e.data);
            event(s, s.runs[initial.id]!, "subagent.completed", {
              childRunId: cr.id,
              state: cr.state,
            });
            return { runId: cr.id, state: cr.state, messages };
          });
        } else {
          result = await this.sandbox.execute(
            initial.actor,
            wid,
            initial.id,
            config.skillBundle,
            bare,
            args,
            controller.signal,
            config.skills,
          );
          if (bare === "read") {
            const fresh = await get();
            const path = (result as { path?: string }).path;
            if (fresh.skills.length && typeof path !== "string")
              throw new Fault(409, "SKILL_IDENTITY_UNCONFIRMED");
            const skill = fresh.skills.find((s) => s.path === path);
            if (
              skill &&
              (result as { sha256?: string }).sha256 !== skill.digest
            )
              throw new Fault(409, "SKILL_DIGEST_MISMATCH");
          }
        }
        await emit("tool.completed", { name, callId, result });
        return result;
      } catch (e) {
        telemetry.error("tool", e, { callId });
        if (
          e instanceof Fault &&
          ["REMOTE_CANCEL_UNCONFIRMED", "MCP_OUTCOME_UNKNOWN"].includes(e.code)
        ) {
          fault = e.code;
          controller.abort(e);
        }
        await emit("tool.failed", {
          name,
          callId,
          code: e instanceof Fault ? e.code : "TOOL_FAILED",
        });
        throw e;
      }
    };
    try {
      let ctx = await get();
      const mcp = await this.mcp.discover(
        initial.actor,
        ctx.config,
        controller.signal,
        initial.deadline,
      );
      let prompt = ctx.r.prompt;
      if (initial.resumedFrom) {
        const i = await this.service.store.read(
          tenant,
          (s) => s.interactions[initial.resumedFrom!],
        );
        if (i?.kind === "approval" && i.response === "approve") {
          const p = i.payload as {
            name: string;
            args: Record<string, unknown>;
          };
          const result = await executeTool(
            p.name,
            p.args,
            ctx.config,
            ctx.ses.workspaceId,
            mcp.call,
            mcp.authorize,
            true,
          );
          prompt += `\nApproved operation completed: ${JSON.stringify(result)}`;
        }
      }
      ctx = await get();
      const modelStarted = Date.now();
      try {
        await this.runtime.execute({
          beforeModelRequest: async (estimate) => {
            try {
              return await this.ledger.reserve(
                tenant,
                initial.id,
                estimate,
                this.owner,
              );
            } catch (e) {
              fault = e instanceof Fault ? e.code : "MODEL_BUDGET_CHECK_FAILED";
              controller.abort(e);
              throw e;
            }
          },
          recordModelUsage: (requestId, usage, duration) =>
            this.ledger.settle(tenant, requestId, usage, duration),
          config: ctx.config,
          entries: ctx.ses.entries,
          prompt,
          skills: ctx.skills,
          specs: [...specs(ctx.config.tools), ...mcp.specs],
          signal: controller.signal,
          call: async (name, args) => {
            const fresh = await get();
            return executeTool(
              name,
              args,
              fresh.config,
              fresh.ses.workspaceId,
              mcp.call,
              mcp.authorize,
            );
          },
          emit,
          consume: async (tokens, turn) => {
            const code = await this.service.store.tx(tenant, (s) => {
              const r = this.owned(s, initial.id);
              const { config } = authorizedRun(s, r);
              let root = r;
              while (root.parentRunId) root = s.runs[root.parentRunId]!;
              const rc =
                root.capabilities ??
                s.agents[s.sessions[root.sessionId]!.agentVersionId]!.config;
              r.tokens = (r.tokens ?? 0) + tokens;
              if (root.id !== r.id) root.tokens = (root.tokens ?? 0) + tokens;
              if (turn) {
                r.steps++;
                if (root.id !== r.id) root.steps++;
              }
              if (r.steps > config.maxSteps || root.steps > rc.maxSteps)
                return "STEP_BUDGET_EXCEEDED";
              if (
                r.tokens > config.maxTokens ||
                (root.tokens ?? 0) > rc.maxTokens
              )
                return "TOKEN_BUDGET_EXCEEDED";
            });
            if (code) throw new Fault(429, code);
          },
          checkpoint: (entries) =>
            this.service.store.tx(tenant, (s) => {
              const r = this.owned(s, initial.id);
              s.sessions[r.sessionId]!.entries = entries;
            }),
        });
      } finally {
        telemetry.duration("model", Date.now() - modelStarted);
      }
      if (!waiting) {
        controller.signal.throwIfAborted();
        await this.service.store.tx(tenant, (s) => {
          const r = this.owned(s, initial.id);
          authorizedRun(s, r);
          r.state = "COMPLETED";
          event(s, r, "run.completed");
        });
      }
    } catch (e) {
      telemetry.error("run_execute", e, {
        tenantId: tenant,
        runId: initial.id,
        workerId: this.owner,
        requestId: initial.requestId,
      });
      if (!waiting)
        await this.service.store.tx(tenant, (s) => {
          const r = s.runs[initial.id];
          if (!r || r.lease?.owner !== this.owner || terminal(r.state)) return;
          const code =
            fault ?? (e instanceof Fault ? e.code : "RUN_EXECUTION_FAILED");
          r.state = [
            "REMOTE_CANCEL_UNCONFIRMED",
            "MCP_OUTCOME_UNKNOWN",
          ].includes(code)
            ? "FAILED"
            : r.cancelRequested || code === "RUN_CANCELLED"
              ? "CANCELLED"
              : "FAILED";
          r.error = code;
          event(
            s,
            r,
            r.state === "CANCELLED" ? "run.cancelled" : "run.failed",
            { code },
          );
        });
    } finally {
      telemetry.duration("run", Date.now() - started);
      this.controllers.delete(controller);
      clearInterval(heartbeat);
      clearTimeout(timeout);
      await this.service.store.tx(tenant, (s) => {
        const r = s.runs[initial.id];
        if (r?.lease?.owner === this.owner) delete r.lease;
      });
    }
  }
}
