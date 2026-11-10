import { ModelEntry, versionModelCatalog } from "../config/models.js";
import { sealToken } from "../security/token-vault.js";
import { MemoryManager } from "../execution/memory.js";
import { ScheduleService, nextFire } from "../schedules/service.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { admin, agentAllowed, Fault, audit, type Actor } from "../domain.js";
import type { PersonalService } from "../personal-service.js";
import type { SandboxManager } from "../adapters/sandbox.js";
import { replaceAgents } from "../config/agents.js";
import { AgentConfig } from "../domain.js";
import { workspacePath } from "../security-path.js";
const sid = (p: unknown) => z.object({ id: z.string().uuid() }).parse(p).id;
const pagination = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export function personalRoutes(
  app: FastifyInstance,
  service: PersonalService,
  sandbox: SandboxManager,
  actor: (req: object) => Actor,
) {
  const memory = new MemoryManager(service.store, sandbox);
  const memoryConfig = AgentConfig.parse({
    name: "Memory",
    systemPrompt: "",
    model: { provider: "demo", modelId: "demo" },
    tools: [],
    memory: { enabled: true },
  });
  const memoryQuery = z.object({
    cwd: z.string().default("/workspace"),
    scope: z.enum(["user", "project"]).default("user"),
  });
  const memoryRoot = (q: z.infer<typeof memoryQuery>) =>
    q.scope === "user" ? "/workspace/memory" : workspacePath(q.cwd) + "/memory";
  app.get("/api/v1/me/memory", async (req) => {
    const a = actor(req),
      q = memoryQuery.parse(req.query),
      w = await service.ensureWorkspace(a);
    return sandbox.executeFile(a, w.id, req.id, "ls", {
      path: memoryRoot(q),
      _workspaceOnly: true,
    });
  });
  app.get("/api/v1/me/memory/:name", async (req) => {
    const a = actor(req),
      q = memoryQuery.parse(req.query),
      w = await service.ensureWorkspace(a),
      name = z
        .object({ name: z.string().regex(/^[a-zA-Z0-9_-]+\.md$/) })
        .parse(req.params).name;
    return sandbox.executeFile(a, w.id, req.id, "read", {
      path: memoryRoot(q) + "/" + name,
      _workspaceOnly: true,
    });
  });
  app.put("/api/v1/me/memory/:name", async (req) => {
    const a = actor(req),
      q = memoryQuery.parse(req.query),
      w = await service.ensureWorkspace(a),
      name = z
        .object({ name: z.string().regex(/^[a-zA-Z0-9_-]+\.md$/) })
        .parse(req.params).name,
      b = z
        .object({ content: z.string().max(32000) })
        .strict()
        .parse(req.body);
    return memory.write(
      a,
      w.id,
      req.id,
      memoryConfig,
      workspacePath(q.cwd),
      memoryRoot(q) + "/" + name,
      b.content,
      new AbortController().signal,
      true,
    );
  });
  const schedules = new ScheduleService(service);
  const enabled = () => {
    if (process.env.SCHEDULES_ENABLED !== "true")
      throw new Fault(404, "SCHEDULES_DISABLED");
  };
  app.post("/api/v1/schedules/preview", async (req) => {
    enabled();
    const b = z
      .object({
        cron: z.string(),
        timezone: z.string().default("UTC"),
        count: z.number().int().min(1).max(20).default(5),
      })
      .strict()
      .parse(req.body);
    let now = Date.now();
    return {
      items: Array.from({ length: b.count }, () => {
        now = nextFire(b.cron, b.timezone, now);
        return new Date(now).toISOString();
      }),
    };
  });
  app.post("/api/v1/schedules", async (req, reply) => {
    enabled();
    return reply.code(201).send(await schedules.create(actor(req), req.body));
  });
  app.get("/api/v1/schedules", async (req) => {
    enabled();
    const a = actor(req);
    return service.store.read(a.tenantId, (s) => ({
      items: Object.values(s.schedules ?? {}),
    }));
  });
  app.get("/api/v1/schedules/:id", async (req) => {
    enabled();
    const a = actor(req);
    return service.store.read(a.tenantId, (s) =>
      schedules.get(s, a, sid(req.params)),
    );
  });
  app.patch("/api/v1/schedules/:id", async (req) => {
    enabled();
    return schedules.update(actor(req), sid(req.params), req.body);
  });
  app.delete("/api/v1/schedules/:id", async (req) => {
    enabled();
    const a = actor(req);
    return service.store.tx(a.tenantId, (s) => {
      schedules.get(s, a, sid(req.params));
      delete s.schedules![sid(req.params)];
      return { deleted: true };
    });
  });
  app.post("/api/v1/schedules/:id/run", async (req, reply) => {
    enabled();
    return reply
      .code(202)
      .send(await schedules.manual(actor(req), sid(req.params)));
  });
  app.get("/api/v1/schedules/:id/runs", async (req) => {
    enabled();
    const a = actor(req);
    return service.store.read(a.tenantId, (s) => {
      schedules.get(s, a, sid(req.params));
      return {
        items: Object.values(s.scheduleFires ?? {}).filter(
          (f) => f.scheduleId === sid(req.params),
        ),
      };
    });
  });
  app.get("/api/v1/agents/:key", async (req) => {
    const key = z.object({ key: z.string() }).parse(req.params).key;
    return service.registry.read((s) => {
      const v = s.managedAgents?.[key];
      if (!v || !agentAllowed(v, actor(req)))
        throw new Fault(404, "AGENT_NOT_FOUND");
      return v;
    });
  });
  app.get("/api/v1/agents/:key/commands", async (req) => {
    const key = z.object({ key: z.string() }).parse(req.params).key;
    return service.registry.read((s) => {
      const v = s.managedAgents?.[key];
      if (!v || !agentAllowed(v, actor(req)))
        throw new Fault(404, "AGENT_NOT_FOUND");
      return {
        items: v.config.skills
          .map((id) => s.skills[id])
          .filter((sk) => sk?.enabled)
          .map((sk) => ({
            name: `skill:${sk!.id}`,
            description: sk!.description,
            path: sk!.path,
          })),
      };
    });
  });
  app.post("/api/v1/sessions", async (req, reply) =>
    reply.code(201).send(
      await service.createPersonalSession(
        actor(req),
        z
          .object({
            agentId: z.string().min(1),
            cwd: z.string().optional(),
            title: z.string().max(200).optional(),
          })
          .strict()
          .parse(req.body),
      ),
    ),
  );
  app.get("/api/v1/sessions", async (req) => {
    const a = actor(req),
      p = pagination.parse(req.query);
    return service.store.read(a.tenantId, (s) => ({
      items: Object.values(s.sessions)
        .filter((v) => v.userId === a.userId && !v.deletedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(p.offset, p.offset + p.limit),
    }));
  });
  app.patch("/api/v1/sessions/:id", async (req) =>
    service.updateSession(
      actor(req),
      sid(req.params),
      z
        .object({
          title: z.string().max(200).optional(),
          cwd: z.string().optional(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.delete("/api/v1/sessions/:id", async (req) =>
    service.deleteSession(actor(req), sid(req.params)),
  );
  app.post("/api/v1/sessions/:id/fork", async (req, reply) =>
    reply
      .code(201)
      .send(await service.forkSession(actor(req), sid(req.params))),
  );
  app.get("/api/v1/me/sandbox", async (req) => {
    const a = actor(req),
      w = await service.ensureWorkspace(a);
    return sandbox.status(a, w.id);
  });
  app.post("/api/v1/me/sandbox/release", async (req) => {
    const a = actor(req),
      w = await service.ensureWorkspace(a);
    await sandbox.release(a, w.id);
    return { released: true };
  });
  app.post("/api/v1/me/sandbox/resume", async (req) => {
    const a = actor(req),
      w = await service.ensureWorkspace(a);
    return sandbox.resume(a, w.id);
  });
  const fileQuery = z.object({
    path: z.string().default("/workspace"),
    operation: z.enum(["read", "ls"]).default("ls"),
  });
  app.get("/api/v1/me/files", async (req) => {
    const a = actor(req),
      q = fileQuery.parse(req.query),
      w = await service.ensureWorkspace(a);
    return sandbox.executeFile(a, w.id, req.id, q.operation, {
      path: workspacePath(q.path),
      _workspaceOnly: true,
    });
  });
  app.put("/api/v1/me/files", async (req) => {
    const a = actor(req),
      b = z
        .object({ path: z.string(), content: z.string().max(262144) })
        .strict()
        .parse(req.body),
      w = await service.ensureWorkspace(a);
    return sandbox.executeFile(a, w.id, req.id, "write", {
      ...b,
      path: workspacePath(b.path),
      _workspaceOnly: true,
    });
  });
  app.delete("/api/v1/me/files", async (req) => {
    const a = actor(req),
      b = z.object({ path: z.string() }).parse(req.query),
      w = await service.ensureWorkspace(a);
    const path = workspacePath(b.path);
    if (path === "/workspace") throw new Fault(403, "PATH_DENIED");
    return sandbox.executeFile(a, w.id, req.id, "delete", {
      path,
      _workspaceOnly: true,
    });
  });
  app.get("/api/v1/admin/config/agents", async (req) => {
    admin(actor(req));
    return service.registry.read((s) => ({
      revision: s.configRevisions?.agents ?? 0,
      items: Object.values(s.managedAgents ?? {}),
    }));
  });
  app.post("/api/v1/admin/config/agents", async (req) => {
    const a = actor(req);
    admin(a);
    const b = z
      .object({
        revision: z.number().int().min(0),
        agents: z.array(z.unknown()).max(1000),
      })
      .strict()
      .parse(req.body);
    return service.registry.tx((s) =>
      replaceAgents(s, b.agents, a, b.revision),
    );
  });

  app.get("/api/v1/admin/config/global", async (req) => {
    admin(actor(req));
    return service.registry.read((s) => ({
      revision: s.configRevisions?.global ?? 0,
      policy: s.policy ?? { disabledTools: [] },
      modelCatalog: (s.modelCatalog ?? []).map(
        ({ gatewayRef, ...entry }) => entry,
      ),
    }));
  });
  app.post("/api/v1/admin/config/global", async (req) => {
    const a = actor(req);
    admin(a);
    const b = z
      .object({
        revision: z.number().int().min(0),
        modelCatalog: z.array(ModelEntry).max(100).optional(),
        secrets: z
          .record(z.string().min(1), z.string().min(1).max(16000))
          .optional(),
        policy: z
          .object({ disabledTools: z.array(z.string()).max(100) })
          .strict(),
      })
      .strict()
      .parse(req.body);
    return service.registry.tx((s) => {
      if ((s.configRevisions?.global ?? 0) !== b.revision)
        throw new Fault(409, "CONFIG_REVISION_CONFLICT");
      if (b.modelCatalog) {
        if (
          b.modelCatalog.length &&
          b.modelCatalog.filter((m) => m.default).length !== 1
        )
          throw new Fault(400, "ONE_DEFAULT_MODEL_REQUIRED");
        if (
          new Set(b.modelCatalog.map((m) => m.provider + "/" + m.modelId))
            .size !== b.modelCatalog.length
        )
          throw new Fault(400, "DUPLICATE_MODEL");
        s.modelCatalog = b.modelCatalog;
      }
      for (const [ref, secret] of Object.entries(b.secrets ?? {}))
        (s.secrets ??= {})[ref] = sealToken(
          secret,
          "platform:" + ref,
          "CONFIG_SECRET_KEY",
        );
      for (const m of s.modelCatalog ?? [])
        if (!s.secrets?.[m.secretRef])
          throw new Fault(400, "MODEL_SECRET_REQUIRED");
      versionModelCatalog(s);
      s.policy = b.policy;
      s.configRevisions ??= { global: 0, agents: 0 };
      s.configRevisions.global++;
      audit(s, a, "global.update", "global");
      return {
        revision: s.configRevisions.global,
        policy: s.policy,
        modelCatalog: (s.modelCatalog ?? []).map(
          ({ gatewayRef, ...entry }) => entry,
        ),
      };
    });
  });
}
