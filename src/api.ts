import { alerts } from "./alerts.js";
import Fastify from "fastify";
import { SandboxReconciler } from "./sandbox-reconciler.js";
import { bounded } from "./health.js";
import { telemetry, traceContext } from "./telemetry.js";
import { usageReport, policyFromEnv } from "./usage.js";
import { z } from "zod";
import {
  Fault,
  admin,
  agentAllowed,
  workspace,
  session,
  run,
  audit,
  type Actor,
} from "./domain.js";
import type { Auth } from "./auth.js";
import type { HarnessService } from "./service.js";
import type { SandboxManager } from "./adapters/sandbox.js";
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
export function buildAPI(
  service: HarnessService,
  auth: Auth,
  sandbox: SandboxManager,
) {
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization"],
      level: process.env.LOG_LEVEL ?? "info",
    },
    bodyLimit: 350000,
    requestTimeout: 30000,
  });
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
      await service.store.tx(a.tenantId, (s) =>
        audit(
          s,
          a,
          `${req.method} ${req.routeOptions.url}`,
          req.id,
          String(reply.statusCode),
        ),
      );
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/api/v1/admin/sandbox/reconcile", async (req) => {
    const a = actor(req);
    admin(a);
    return new SandboxReconciler(service.store, sandbox).scan(a.tenantId);
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
  app.get("/api/v1/agents", async (req) => {
    const a = actor(req),
      p = page.parse(req.query);
    return service.store.read(a.tenantId, (s) => ({
      items: Object.values(s.agents)
        .filter((v) => agentAllowed(v, a))
        .slice(p.offset, p.offset + p.limit),
    }));
  });
  app.post("/api/v1/admin/agents", async (req, reply) =>
    reply.code(201).send(await service.publish(actor(req), req.body)),
  );
  app.get("/api/v1/admin/agents", async (req) => {
    const a = actor(req);
    admin(a);
    const p = page.parse(req.query);
    return service.store.read(a.tenantId, (s) => ({
      items: Object.values(s.agents).slice(p.offset, p.offset + p.limit),
    }));
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
  app.put("/api/v1/admin/agents/:id/access", async (req) => {
    const a = actor(req);
    admin(a);
    const key = uuid.parse(params(req.params).id);
    const b = z
      .object({ allowedUsers: z.array(z.string().min(1).max(200)).max(1000) })
      .strict()
      .parse(req.body);
    return service.store.tx(a.tenantId, (s) => {
      if (!s.agents[key]) throw new Fault(404, "AGENT_NOT_FOUND");
      s.agents[key]!.allowedUsers = b.allowedUsers;
      audit(s, a, "agent.access", key);
      return { allowedUsers: b.allowedUsers };
    });
  });
  app.get("/api/v1/admin/skills", async (req) => {
    const a = actor(req);
    admin(a);
    const p = page.parse(req.query);
    return service.store.read(a.tenantId, (s) => ({
      items: Object.values(s.skills).slice(p.offset, p.offset + p.limit),
    }));
  });
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
      return s.skills[key];
    });
  });
  app.get("/api/v1/admin/mcp-servers", async (req) => {
    const a = actor(req);
    admin(a);
    return service.store.read(a.tenantId, (s) => ({
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
    return service.store.read(a.tenantId, (s) => ({
      items: Object.values(s.workspaces)
        .filter((w) => Object.hasOwn(w.members, a.userId) && !w.deleting)
        .slice(p.offset, p.offset + p.limit)
        .map((w) => ({ id: w.id, name: w.name, members: w.members })),
    }));
  });
  app.get("/api/v1/workspaces/:id", async (req) => {
    const a = actor(req),
      wid = uuid.parse(params(req.params).id);
    return service.store.read(a.tenantId, (s) => {
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
    await service.store.read(a.tenantId, (s) => {
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
    const b = z.object({ agentVersionId: uuid }).strict().parse(req.body);
    return reply
      .code(201)
      .send(
        await service.createSession(
          actor(req),
          uuid.parse(params(req.params).id),
          b.agentVersionId,
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
    );
  });
  app.get("/api/v1/runs/:id", async (req) => {
    const a = actor(req),
      rid = uuid.parse(params(req.params).id);
    return service.store.read(a.tenantId, (s) => {
      const r = run(s, a, rid);
      return { ...r, lease: undefined, actor: undefined };
    });
  });
  app.post("/api/v1/runs/:id/cancel", async (req) =>
    service.cancel(actor(req), uuid.parse(params(req.params).id)),
  );
  app.post("/api/v1/interactions/:id/response", async (req, reply) => {
    const b = z
      .object({ response: z.string().min(1).max(16000) })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        await service.respond(
          actor(req),
          uuid.parse(params(req.params).id),
          b.response,
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
    const w = await service.store.read(a.tenantId, (s) => workspace(s, a, wid));
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
    const w = await service.store.read(a.tenantId, (s) =>
      workspace(s, a, wid, true),
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
    const w = await service.store.read(a.tenantId, (s) => workspace(s, a, wid));
    if (!service.hasBundle(fileBundle(w, a), a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    return sandbox.executeFile(a, wid, req.id, "read", {
      path,
      _workspaceOnly: true,
    });
  });
  return app;
}
