import { alerts } from "./alerts.js";
import { agentAdminHTML } from "./agent-admin-ui.js";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import {
  HostSkillPackages,
  SkillUploadFields,
  skillZipLimits,
} from "./skill-packages.js";
import { usageReport, policyFromEnv } from "./usage.js";
import { telemetry, traceContext } from "./telemetry.js";
import { bounded } from "./health.js";
import { z } from "zod";
import {
  Fault,
  AgentDefaults,
  AgentConfig,
  id,
  admin,
  agentAllowed,
  workspace,
  session,
  run,
  audit,
  type Actor,
  type Run,
} from "./domain.js";
import type { Auth } from "./auth.js";
import type { HarnessService } from "./service.js";
import type { SandboxManager } from "./adapters/sandbox.js";
import type { MCPManager } from "./adapters/mcp.js";
const uuid = z.string().uuid();
const filePath = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (v) =>
      !v.startsWith("/") || v === "/workspace" || v.startsWith("/workspace/"),
    "Workspace paths only",
  );
const fileBundle = (w: { bundle?: string }, a: Actor) => {
  if (!w.bundle) throw new Fault(409, "CREATE_SESSION_FIRST");
  return w.bundle;
};
const params = (x: unknown) => z.record(z.string(), z.string()).parse(x);
const page = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
// Status APIs expose execution metadata, never the private Worker config snapshot.
function publicRun(r: Run | undefined) {
  if (!r) throw new Fault(404, "RUN_NOT_FOUND");
  return {
    id: r.id,
    sessionId: r.sessionId,
    agentVersionId: r.agentVersionId,
    taskId: r.taskId,
    rootRunId: r.rootRunId,
    parentRunId: r.parentRunId,
    resumedFrom: r.resumedFrom,
    state: r.state,
    cancelRequested: r.cancelRequested,
    error: r.error,
    depth: r.depth,
    steps: r.steps,
    children: r.children,
    tokens: r.tokens,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  };
}
export function buildAPI(
  service: HarnessService,
  auth: Auth,
  sandbox: SandboxManager,
  mcp?: MCPManager,
  skillPackages?: HostSkillPackages,
) {
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization"],
      level: process.env.LOG_LEVEL ?? "info",
    },
    bodyLimit: 350000,
    requestTimeout: 30000,
  });
  void app.register(multipart);
  const actors = new WeakMap<object, Actor>();
  const actor = (req: object) => actors.get(req)!;
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number };
    const status =
      err instanceof Fault
        ? err.status
        : err instanceof z.ZodError
          ? 400
          : e.statusCode && e.statusCode < 500
            ? e.statusCode
            : 500;
    void reply.code(status).send({
      error: {
        code:
          err instanceof Fault
            ? err.code
            : err instanceof z.ZodError
              ? "INVALID_REQUEST"
              : status === 500
                ? "INTERNAL_ERROR"
                : "REQUEST_ERROR",
        message: status === 500 ? "Internal server error" : e.message,
        requestId: req.id,
      },
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-ID", req.id);
    // Only the static shell is public; all data and mutations still require admin auth.
    if (
      req.method === "GET" &&
      ["/admin/agents/ui", "/admin/ui"].includes(req.url.split("?")[0]!)
    )
      return;
    if (
      ["/health", "/health/live", "/health/ready"].includes(
        req.url.split("?")[0]!,
      )
    )
      return;
    actors.set(req, await auth(req.headers.authorization));
  });
  app.addHook("onResponse", async (req, reply) => {
    const a = actors.get(req);
    if (a)
      await service.store.appendAudit(a.tenantId, {
        id: id(),
        timestamp: new Date().toISOString(),
        actorId: a.userId,
        action: `${req.method} ${req.routeOptions.url}`,
        resource: req.id,
        result: String(reply.statusCode),
      });
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/admin/ui", async (_req, reply) =>
    reply.redirect("/admin/agents/ui"),
  );
  app.get("/admin/agents/ui", async (_req, reply) => {
    const nonce = randomBytes(16).toString("base64");
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      )
      .type("text/html; charset=utf-8")
      .send(agentAdminHTML.replace("__AGENT_UI_NONCE__", nonce));
  });
  app.get("/api/v1/admin/configuration", async (req, reply) => {
    const a = actor(req);
    const deployment = service.adminConfiguration(a);
    reply.header("Cache-Control", "no-store");
    const settings = await service.store.readMetadata(
      a.tenantId,
      ["agentDefaults", "defaultsRevision"],
      (s) => ({
        agentDefaults: s.agentDefaults,
        defaultsRevision: s.defaultsRevision ?? 0,
      }),
    );
    return {
      tenantId: a.tenantId,
      deployment: {
        ...deployment,
        sandbox: sandbox.policy,
        editable: false,
        changesRequireRestart: true,
      },
      skillUploads: skillPackages?.configuration ?? {
        enabled: false,
        ...skillZipLimits,
      },
      defaultsRevision: settings.defaultsRevision,
      agentDefaults: settings.agentDefaults ?? {
        model:
          deployment.models[0] ??
          (process.env.HARNESS_MODE === "demo"
            ? { provider: "demo", modelId: "demo" }
            : { provider: "", modelId: "" }),
        tools: ["read", "ls", "grep", "find"],
        skillBundle: deployment.bundles[0] ?? "",
        maxSteps: 30,
        maxTokens: 100000,
        timeoutSeconds: 600,
        maxSubagents: 2,
        maxDepth: 1,
      },
      defaultsScope: "tenant-new-agent-drafts",
    };
  });
  app.put("/api/v1/admin/configuration/defaults", async (req) => {
    const a = actor(req);
    const deployment = service.adminConfiguration(a);
    const { expectedRevision, ...defaults } = AgentDefaults.extend({
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
    }).parse(req.body);
    if (
      deployment.modelApprovalRequired &&
      !deployment.models.some(
        (m) =>
          m.provider === defaults.model.provider &&
          m.modelId === defaults.model.modelId,
      )
    )
      throw new Fault(403, "MODEL_NOT_APPROVED");
    if (!service.hasBundle(defaults.skillBundle, a.tenantId))
      throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
    return service.store.tx(a.tenantId, (s) => {
      if ((s.defaultsRevision ?? 0) !== expectedRevision)
        throw new Fault(
          409,
          "DEFAULTS_CONFLICT",
          "Defaults were updated by another administrator",
        );
      s.agentDefaults = defaults;
      s.defaultsRevision = expectedRevision + 1;
      audit(s, a, "configuration.defaults", a.tenantId);
      return { agentDefaults: defaults, defaultsRevision: s.defaultsRevision };
    });
  });
  app.post("/api/v1/admin/mcp-servers/:id/check", async (req) => {
    const a = actor(req);
    admin(a);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const key = params(req.params).id!;
    const reg = await service.store.readMetadata(
      a.tenantId,
      ["mcp"],
      (s) => s.mcp[key],
    );
    if (!reg) throw new Fault(404, "MCP_NOT_FOUND");
    if (!reg.enabled) throw new Fault(403, "MCP_DISABLED");
    if (!service.hasEndpoint(reg.endpointRef, a.tenantId))
      throw new Fault(403, "MCP_ENDPOINT_NOT_GRANTED");
    if (!mcp) throw new Fault(503, "MCP_CHECK_UNAVAILABLE");
    // Discovery only: no tool execution. Existing MCP transport enforces HTTPS,
    // server-side credentials, grants, whitelists, pagination and a total deadline.
    const result = await mcp.discover(
      a,
      AgentConfig.parse({
        name: "connection-check",
        systemPrompt: "",
        model: { provider: "check", modelId: "check" },
        tools: [],
        skillBundle: "check",
        mcpServers: [key],
      }),
      undefined,
      Date.now() + 10000,
    );
    return {
      status: "ok",
      tools: result.specs.map((t) => ({
        name: t.name,
        description: t.description,
      })),
      checkedAt: new Date().toISOString(),
    };
  });
  app.get("/api/v1/admin/usage", async (req) => {
    const a = actor(req);
    admin(a);
    return service.store.read(a.tenantId, (s) =>
      usageReport(s, policyFromEnv()),
    );
  });
  app.get("/api/v1/usage", async (req) => {
    const a = actor(req);
    return service.store.read(a.tenantId, (s) =>
      usageReport(s, policyFromEnv(), a.userId),
    );
  });
  app.get("/api/v1/runs/:id/usage", async (req) => {
    const a = actor(req),
      rid = uuid.parse(params(req.params).id);
    return service.store.read(a.tenantId, (s) => {
      run(s, a, rid);
      return usageReport(s, policyFromEnv(), undefined, rid);
    });
  });
  app.get("/api/v1/admin/metrics", async (req) => {
    admin(actor(req));
    const capacity = await service.store.capacityRead((s) =>
      Object.values(s.entries).reduce<Record<string, number>>((counts, e) => {
        counts[e.state] = (counts[e.state] ?? 0) + 1;
        return counts;
      }, {}),
    );
    return {
      counters: telemetry.snapshot(),
      sandbox: capacity,
      alerts: alerts({}, {}, capacity.unknown ?? 0),
    };
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await bounded(service.store.ready());
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.get("/api/v1/admin/health/workers", async (req, reply) => {
    admin(actor(req));
    const workers = await bounded(service.store.workerHealth());
    const healthy = workers.filter(
      (w) =>
        !w.stopping &&
        Date.now() - w.heartbeatAt < 15000 &&
        w.lastSuccessfulTick !== undefined &&
        Date.now() - w.lastSuccessfulTick < 15000,
    );
    return reply.code(healthy.length ? 200 : 503).send({
      status: healthy.length ? "ok" : "no_healthy_worker",
      workers: workers.map((w) => ({
        ...w,
        stale: Date.now() - w.heartbeatAt >= 15000,
      })),
    });
  });
  app.get("/api/v1/agents", async (req) => {
    const a = actor(req),
      p = page.parse(req.query);
    return service.store.readMetadata(
      a.tenantId,
      ["agents", "logicalAgents"],
      (s) => ({
        items: Object.values(s.agents)
          .filter((v) => agentAllowed(v, a, s))
          .slice(p.offset, p.offset + p.limit),
      }),
    );
  });
  app.post("/api/v1/admin/agents", async (req, reply) =>
    reply.code(201).send(await service.publish(actor(req), req.body)),
  );
  app.post("/api/v1/admin/agents/:id/versions", async (req, reply) =>
    reply
      .code(201)
      .send(
        await service.publish(
          actor(req),
          req.body,
          uuid.parse(params(req.params).id),
        ),
      ),
  );
  app.put("/api/v1/admin/agents/:id/active-version", async (req) => {
    const b = z.object({ agentVersionId: uuid }).strict().parse(req.body);
    return service.activate(
      actor(req),
      uuid.parse(params(req.params).id),
      b.agentVersionId,
    );
  });
  app.get("/api/v1/logical-agents", async (req) => {
    const a = actor(req),
      p = page.parse(req.query);
    return service.store.readMetadata(
      a.tenantId,
      ["logicalAgents", "agents"],
      (s) => ({
        items: Object.values(s.logicalAgents)
          .filter(
            (v) =>
              s.agents[v.activeVersionId] &&
              agentAllowed(s.agents[v.activeVersionId]!, a, s),
          )
          .slice(p.offset, p.offset + p.limit),
      }),
    );
  });
  app.get("/api/v1/admin/agents", async (req) => {
    const a = actor(req);
    admin(a);
    const p = page.parse(req.query);
    return service.store.readMetadata(
      a.tenantId,
      ["agents", "logicalAgents"],
      (s) => ({
        items: Object.values(s.agents)
          .slice(p.offset, p.offset + p.limit)
          .map((version) => {
            const logical = s.logicalAgents[version.agentId ?? version.id];
            return {
              ...version,
              agentId: logical?.id ?? version.agentId ?? version.id,
              activeVersionId: logical?.activeVersionId ?? version.id,
              allowedUsers: logical
                ? (logical.allowedUsers ?? [])
                : (version.allowedUsers ?? []),
            };
          }),
      }),
    );
  });
  app.put("/api/v1/admin/agents/:id/status", async (req) => {
    const a = actor(req);
    admin(a);
    const key = uuid.parse(params(req.params).id);
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return service.store.tx(a.tenantId, (s) => {
      if (!s.agents[key]) throw new Fault(404, "AGENT_NOT_FOUND");
      s.agents[key]!.enabled = b.enabled;
      audit(s, a, "agent.status", key);
      return s.agents[key];
    });
  });
  for (const path of [
    "/api/v1/admin/agents/:id/access",
    "/api/v1/admin/logical-agents/:id/access",
  ]) {
    app.put(path, async (req) => {
      const b = z
        .object({ allowedUsers: z.array(z.string().min(1).max(200)).max(1000) })
        .strict()
        .parse(req.body);
      return service.setAccess(
        actor(req),
        uuid.parse(params(req.params).id),
        b.allowedUsers,
      );
    });
  }
  app.get("/api/v1/admin/skills", async (req) => {
    const a = actor(req);
    admin(a);
    const p = page.parse(req.query);
    return service.store.readMetadata(a.tenantId, ["skills"], (s) => ({
      items: Object.values(s.skills).slice(p.offset, p.offset + p.limit),
    }));
  });
  app.post(
    "/api/v1/admin/skills/upload",
    { bodyLimit: skillZipLimits.maxArchiveBytes + 65536 },
    async (req, reply) => {
      const a = actor(req);
      admin(a);
      if (!skillPackages?.configuration.enabled)
        throw new Fault(
          503,
          "SKILL_UPLOAD_DISABLED",
          "Host Skill uploads are not configured",
        );
      return skillPackages.withSlot(async () => {
        if (!req.isMultipart())
          throw new Fault(
            415,
            "SKILL_ZIP_CONTENT_TYPE",
            "Send a multipart form with one archive file",
          );
        const fields: Record<string, unknown> = Object.create(null);
        let archive: Buffer | undefined;
        for await (const part of req.parts({
          limits: {
            files: 1,
            fields: 4,
            parts: 5,
            fileSize: skillZipLimits.maxArchiveBytes,
            fieldSize: 8192,
          },
        })) {
          if (part.type === "file") {
            if (part.fieldname !== "archive" || archive)
              throw new Fault(
                400,
                "INVALID_REQUEST",
                "Exactly one archive file is required",
              );
            archive = await part.toBuffer();
            if (part.file.truncated) throw new Fault(413, "SKILL_ZIP_LIMIT");
          } else {
            if (Object.hasOwn(fields, part.fieldname) || part.valueTruncated)
              throw new Fault(
                400,
                "INVALID_REQUEST",
                "Duplicate or truncated upload field",
              );
            fields[part.fieldname] = part.value;
          }
        }
        const input = SkillUploadFields.parse(fields);
        if (!archive)
          throw new Fault(400, "INVALID_REQUEST", "Choose a Skill ZIP archive");
        if (!service.hasBundle(input.bundle, a.tenantId))
          throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
        await service.store.readMetadata(a.tenantId, ["skills"], (s) => {
          if (s.skills[input.id])
            throw new Fault(409, "IMMUTABLE_SKILL_VERSION");
        });
        if (req.raw.aborted) throw new Fault(400, "UPLOAD_ABORTED");
        if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
          throw new Fault(401, "UNAUTHENTICATED");
        const prepared = await skillPackages.prepare(
          a.tenantId,
          input,
          archive,
        );
        let metadataMayHaveCommitted = false;
        try {
          if (req.raw.aborted) throw new Fault(400, "UPLOAD_ABORTED");
          if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
            throw new Fault(401, "UNAUTHENTICATED");
          const skill = await service.store.tx(a.tenantId, (s) => {
            if (req.raw.aborted) throw new Fault(400, "UPLOAD_ABORTED");
            if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
              throw new Fault(401, "UNAUTHENTICATED");
            if (s.skills[input.id])
              throw new Fault(409, "IMMUTABLE_SKILL_VERSION");
            s.skills[input.id] = prepared.skill;
            audit(
              s,
              a,
              "skill.upload",
              input.id,
              JSON.stringify({
                files: prepared.skill.hostUpload!.files,
                bytes: prepared.skill.hostUpload!.bytes,
              }),
            );
            metadataMayHaveCommitted = true;
            return prepared.skill;
          });
          return reply.code(201).send(skill);
        } catch (error) {
          if (!metadataMayHaveCommitted) await prepared.discard();
          throw error;
        }
      });
    },
  );
  app.post("/api/v1/admin/skills", async (req, reply) => {
    const a = actor(req);
    admin(a);
    const b = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/),
        name: z.string().min(1).max(100),
        description: z.string().max(2000),
        bundle: z.string(),
        path: z.string().regex(/^\/skills\/(?:[a-zA-Z0-9_-]+\/)+SKILL\.md$/),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(req.body);
    if (!service.hasBundle(b.bundle, a.tenantId))
      throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
    return reply.code(201).send(
      await service.store.tx(a.tenantId, (s) => {
        if (s.skills[b.id]) throw new Fault(409, "IMMUTABLE_SKILL_VERSION");
        s.skills[b.id] = { ...b, enabled: true };
        audit(s, a, "skill.register", b.id);
        return s.skills[b.id];
      }),
    );
  });
  app.put("/api/v1/admin/skills/:id/status", async (req) => {
    const a = actor(req);
    admin(a);
    const key = params(req.params).id!;
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return service.store.tx(a.tenantId, (s) => {
      if (!s.skills[key]) throw new Fault(404, "SKILL_NOT_FOUND");
      s.skills[key]!.enabled = b.enabled;
      audit(s, a, "skill.status", key);
      return s.skills[key];
    });
  });
  app.get("/api/v1/admin/mcp-servers", async (req) => {
    const a = actor(req);
    admin(a);
    return service.store.readMetadata(a.tenantId, ["mcp"], (s) => ({
      items: Object.values(s.mcp),
    }));
  });
  app.post("/api/v1/admin/mcp-servers", async (req, reply) => {
    const a = actor(req);
    admin(a);
    const b = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,20}$/),
        endpointRef: z.string().min(1),
        allowedTools: z.array(z.string().min(1).max(64)).max(100),
      })
      .strict()
      .parse(req.body);
    if (!service.hasEndpoint(b.endpointRef, a.tenantId))
      throw new Fault(400, "MCP_ENDPOINT_NOT_REGISTERED");
    return reply.code(201).send(
      await service.store.tx(a.tenantId, (s) => {
        if (s.mcp[b.id]) throw new Fault(409, "MCP_ALREADY_REGISTERED");
        s.mcp[b.id] = { ...b, enabled: true };
        audit(s, a, "mcp.register", b.id);
        return s.mcp[b.id];
      }),
    );
  });
  app.put("/api/v1/admin/mcp-servers/:id/status", async (req) => {
    const a = actor(req);
    admin(a);
    const key = params(req.params).id!;
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return service.store.tx(a.tenantId, (s) => {
      if (!s.mcp[key]) throw new Fault(404, "MCP_NOT_FOUND");
      s.mcp[key]!.enabled = b.enabled;
      audit(s, a, "mcp.status", key);
      return s.mcp[key];
    });
  });
  app.get("/api/v1/admin/audit", async (req) => {
    const a = actor(req);
    admin(a);
    const p = page.parse(req.query);
    return service.store.read(a.tenantId, (s) => ({
      items: s.audit.slice(p.offset, p.offset + p.limit),
    }));
  });
  app.get("/api/v1/admin/stats", async (req) => {
    const a = actor(req);
    admin(a);
    return service.store.read(a.tenantId, (s) => {
      const runs = Object.values(s.runs);
      const byState: Record<string, number> = {};
      for (const r of runs) byState[r.state] = (byState[r.state] ?? 0) + 1;
      const durations = runs
        .filter((r) => r.startedAt && r.endedAt)
        .map((r) => Date.parse(r.endedAt!) - Date.parse(r.startedAt!));
      return {
        runs: byState,
        pendingInteractions: Object.values(s.interactions).filter(
          (i) => !i.resolved && s.runs[i.runId]?.state === "WAITING_INPUT",
        ).length,
        averageRunDurationMs: durations.length
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0,
        toolFailures: s.events.filter((e) => e.type === "tool.failed").length,
      };
    });
  });
  app.post("/api/v1/workspaces", async (req, reply) => {
    const b = z
      .object({ name: z.string().min(1).max(100) })
      .strict()
      .parse(req.body);
    const w = await service.createWorkspace(actor(req), b.name);
    return reply.code(201).send({ id: w.id, name: w.name, members: w.members });
  });
  app.get("/api/v1/workspaces", async (req) => {
    const a = actor(req),
      p = page.parse(req.query);
    return service.store.readMetadata(a.tenantId, ["workspaces"], (s) => ({
      items: Object.values(s.workspaces)
        .filter((w) => Object.hasOwn(w.members, a.userId) && !w.deleting)
        .slice(p.offset, p.offset + p.limit)
        .map((w) => ({ id: w.id, name: w.name, members: w.members })),
    }));
  });
  app.get("/api/v1/workspaces/:id", async (req) => {
    const a = actor(req),
      wid = uuid.parse(params(req.params).id);
    return service.store.readMetadata(a.tenantId, ["workspaces"], (s) => {
      const w = workspace(s, a, wid);
      return { id: w.id, name: w.name, members: w.members };
    });
  });
  app.put("/api/v1/workspaces/:id/members/:userId", async (req) => {
    const a = actor(req),
      p = params(req.params),
      wid = uuid.parse(p.id);
    const b = z
      .object({ role: z.enum(["editor", "viewer"]).nullable() })
      .strict()
      .parse(req.body);
    return service.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid, true);
      if (w.ownerId !== a.userId) throw new Fault(403, "OWNER_REQUIRED");
      if (w.ownerId === p.userId) throw new Fault(400, "OWNER_IMMUTABLE");
      if (b.role)
        Object.defineProperty(w.members, p.userId!, {
          value: b.role,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else delete w.members[p.userId!];
      audit(s, a, "workspace.members", wid);
      return { members: w.members };
    });
  });
  app.delete("/api/v1/workspaces/:id", async (req, reply) => {
    const a = actor(req),
      wid = uuid.parse(params(req.params).id);
    await service.store.readMetadata(a.tenantId, ["workspaces"], (s) => {
      if (workspace(s, a, wid, true).ownerId !== a.userId)
        throw new Fault(403, "OWNER_REQUIRED");
    });
    await sandbox.destroy(a, wid);
    return reply.code(204).send();
  });
  app.post("/api/v1/workspaces/:id/sandbox/pause", async (req, reply) => {
    await sandbox.pause(actor(req), uuid.parse(params(req.params).id));
    return reply.code(204).send();
  });
  app.get("/api/v1/sandbox-capacity", async (req) =>
    sandbox.capacity.usage(actor(req)),
  );
  app.get("/api/v1/workspaces/:id/sandbox", async (req) =>
    sandbox.status(actor(req), uuid.parse(params(req.params).id)),
  );
  app.post("/api/v1/workspaces/:id/sandbox/resume", async (req) =>
    sandbox.resume(actor(req), uuid.parse(params(req.params).id)),
  );
  app.delete("/api/v1/workspaces/:id/sandbox", async (req, reply) => {
    await sandbox.release(actor(req), uuid.parse(params(req.params).id));
    return reply.code(204).send();
  });
  const snapshotParams = (p: unknown) => {
    const v = params(p);
    return {
      wid: uuid.parse(v.id),
      snapshotId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,128}$/)
        .parse(v.snapshotId),
    };
  };
  app.get("/api/v1/workspaces/:id/sandbox/snapshots", async (req) =>
    sandbox.listSnapshots(actor(req), uuid.parse(params(req.params).id)),
  );
  app.post("/api/v1/workspaces/:id/sandbox/snapshots", async (req, reply) => {
    const b = z
      .object({ name: z.string().min(1).max(100).optional() })
      .strict()
      .parse(req.body ?? {});
    return reply
      .code(201)
      .send(
        await sandbox.createSnapshot(
          actor(req),
          uuid.parse(params(req.params).id),
          b.name,
        ),
      );
  });
  app.delete(
    "/api/v1/workspaces/:id/sandbox/snapshots/:snapshotId",
    async (req, reply) => {
      const p = snapshotParams(req.params);
      await sandbox.deleteSnapshot(actor(req), p.wid, p.snapshotId);
      return reply.code(204).send();
    },
  );
  app.post(
    "/api/v1/workspaces/:id/sandbox/snapshots/:snapshotId/restore",
    async (req) => {
      const p = snapshotParams(req.params);
      return sandbox.restoreSnapshot(actor(req), p.wid, p.snapshotId);
    },
  );
  app.post(
    "/api/v1/workspaces/:id/sandbox/snapshots/:snapshotId/clone",
    async (req, reply) => {
      const p = snapshotParams(req.params),
        b = z
          .object({ name: z.string().min(1).max(100) })
          .strict()
          .parse(req.body);
      return reply
        .code(201)
        .send(
          await sandbox.cloneSnapshot(actor(req), p.wid, p.snapshotId, b.name),
        );
    },
  );
  app.post("/api/v1/workspaces/:id/sessions", async (req, reply) => {
    const b = z
      .object({ agentId: uuid.optional(), agentVersionId: uuid.optional() })
      .strict()
      .refine(
        (b) => !!b.agentId !== !!b.agentVersionId,
        "Provide exactly one Agent selector",
      )
      .parse(req.body);
    return reply
      .code(201)
      .send(
        await service.createSession(
          actor(req),
          uuid.parse(params(req.params).id),
          (b.agentId ?? b.agentVersionId)!,
        ),
      );
  });
  app.get("/api/v1/workspaces/:id/sessions", async (req) => {
    const a = actor(req),
      wid = uuid.parse(params(req.params).id),
      p = page.parse(req.query);
    return service.store.read(a.tenantId, (s) => {
      workspace(s, a, wid);
      return {
        items: Object.values(s.sessions)
          .filter((v) => v.workspaceId === wid)
          .slice(p.offset, p.offset + p.limit),
      };
    });
  });
  app.get("/api/v1/sessions/:id", async (req) => {
    const a = actor(req),
      sid = uuid.parse(params(req.params).id);
    return service.store.read(a.tenantId, (s) => ({
      ...session(s, a, sid),
      todos: s.todos[sid] ?? [],
    }));
  });
  app.post("/api/v1/sessions/:id/runs", async (req, reply) => {
    const b = z
      .object({ message: z.string().min(1).max(32000) })
      .strict()
      .parse(req.body);
    const k = req.headers["idempotency-key"];
    const key =
      k === undefined ? undefined : z.string().min(1).max(128).parse(k);
    return reply.code(202).send(
      publicRun(
        await service.submit(
          actor(req),
          uuid.parse(params(req.params).id),
          b.message,
          key,
          req.id,
          (() => {
            const trace = traceContext(
              typeof req.headers.traceparent === "string"
                ? req.headers.traceparent
                : undefined,
            );
            return `00-${trace.traceId}-${trace.spanId}-01`;
          })(),
        ),
      ),
    );
  });
  app.get("/api/v1/runs/:id", async (req) => {
    const a = actor(req),
      rid = uuid.parse(params(req.params).id);
    return service.store.readRun(a.tenantId, rid, (s) => {
      const r = run(s, a, rid);
      return publicRun(r);
    });
  });
  app.post("/api/v1/runs/:id/cancel", async (req) =>
    publicRun(
      await service.cancel(actor(req), uuid.parse(params(req.params).id)),
    ),
  );
  app.post("/api/v1/interactions/:id/response", async (req, reply) => {
    const b = z
      .object({ response: z.string().min(1).max(16000) })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        publicRun(
          await service.respond(
            actor(req),
            uuid.parse(params(req.params).id),
            b.response,
          ),
        ),
      );
  });
  app.get("/api/v1/runs/:id/events", async (req, reply) => {
    const a = actor(req),
      rid = uuid.parse(params(req.params).id);
    const q = z
      .object({ after: z.coerce.number().int().min(0).optional() })
      .parse(req.query);
    let cursor =
      q.after ??
      z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.headers["last-event-id"] ?? 0);
    await service.store.eventPage(
      a.tenantId,
      rid,
      cursor,
      0,
      (s) => run(s, a, rid).state,
    );
    if (a.expiresAt !== undefined && Date.now() >= a.expiresAt)
      throw new Fault(401, "AUTHENTICATION_EXPIRED");
    reply.hijack();
    telemetry.count("sse_active", 1);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-ID": req.id,
    });
    let closed = false;
    const disconnected = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = () =>
      a.expiresAt !== undefined && Date.now() >= a.expiresAt;
    const expire = () => {
      if (closed) return;
      closed = true;
      disconnected.abort();
      // A stalled reader may prevent end() from flushing and emitting close.
      // Destroy a backpressured response so expiry also releases the waiter.
      if (reply.raw.writableNeedDrain) reply.raw.destroy();
      else
        reply.raw.end(
          'event: stream.error\ndata: {"code":"AUTHENTICATION_EXPIRED"}\n\n',
        );
    };
    const armExpiry = () => {
      if (a.expiresAt === undefined || closed) return;
      const remaining = a.expiresAt - Date.now();
      if (remaining <= 0) return expire();
      expiryTimer = setTimeout(
        () => {
          if (expired()) expire();
          else armExpiry();
        },
        Math.min(remaining, 2147483647),
      );
    };
    reply.raw.on("close", () => {
      closed = true;
      clearTimeout(expiryTimer);
      disconnected.abort();
      telemetry.count("sse_active", -1);
    });
    armExpiry();
    let lastBeat = Date.now();
    try {
      while (!closed) {
        if (expired()) {
          expire();
          break;
        }
        const batch = await service.store.eventPage(
          a.tenantId,
          rid,
          cursor,
          100,
          (s) => run(s, a, rid).state,
        );
        if (expired()) expire();
        if (closed) break;
        for (const e of batch.events) {
          // A database read or backpressure wait may cross the JWT deadline.
          if (expired()) expire();
          if (closed) break;
          cursor = e.eventId;
          if (
            !reply.raw.write(
              `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
            )
          ) {
            await new Promise<void>((resolve) => {
              const done = () => {
                reply.raw.off("drain", done);
                reply.raw.off("close", done);
                resolve();
              };
              reply.raw.once("drain", done);
              reply.raw.once("close", done);
            });
            if (closed) break;
          }
        }
        if (
          batch.events.length < 100 &&
          ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"].includes(
            batch.state,
          )
        )
          break;
        if (Date.now() - lastBeat > 15000) {
          reply.raw.write(": heartbeat\n\n");
          lastBeat = Date.now();
        }
        if (closed) break;
        if (batch.events.length === 100) {
          // Catch up immediately, while yielding between pages for other clients.
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        await service.store.waitForEvents(
          a.tenantId,
          rid,
          250,
          disconnected.signal,
        );
      }
    } catch {
      if (!closed)
        reply.raw.write(
          'event: stream.error\ndata: {"code":"ACCESS_REVOKED_OR_UNAVAILABLE"}\n\n',
        );
    } finally {
      clearTimeout(expiryTimer);
      reply.raw.end();
    }
  });
  app.get("/api/v1/workspaces/:id/files", async (req) => {
    const a = actor(req),
      wid = uuid.parse(params(req.params).id);
    const q = z
      .object({ path: filePath.default("/workspace") })
      .parse(req.query);
    const w = await service.store.readMetadata(
      a.tenantId,
      ["workspaces"],
      (s) => workspace(s, a, wid),
    );
    if (!service.hasBundle(fileBundle(w, a), a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    return sandbox.executeFile(a, wid, req.id, "ls", {
      path: q.path,
      _workspaceOnly: true,
    });
  });
  app.post("/api/v1/workspaces/:id/files", async (req, reply) => {
    const a = actor(req),
      wid = uuid.parse(params(req.params).id);
    const b = z
      .object({
        path: filePath,
        content: z.string().max(262144),
      })
      .strict()
      .parse(req.body);
    const w = await service.store.readMetadata(
      a.tenantId,
      ["workspaces"],
      (s) => workspace(s, a, wid, true),
    );
    if (!service.hasBundle(fileBundle(w, a), a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    await sandbox.executeFile(a, wid, req.id, "write", {
      ...b,
      _workspaceOnly: true,
    });
    return reply
      .code(201)
      .send({ fileId: Buffer.from(b.path).toString("base64url") });
  });
  app.get("/api/v1/workspaces/:id/files/:fileId", async (req) => {
    const a = actor(req),
      p = params(req.params),
      wid = uuid.parse(p.id);
    const file = z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(3000)
      .parse(p.fileId);
    const path = filePath.parse(
      Buffer.from(file, "base64url").toString("utf8"),
    );
    const w = await service.store.readMetadata(
      a.tenantId,
      ["workspaces"],
      (s) => workspace(s, a, wid),
    );
    if (!service.hasBundle(fileBundle(w, a), a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    return sandbox.executeFile(a, wid, req.id, "read", {
      path,
      _workspaceOnly: true,
    });
  });
  return app;
}
