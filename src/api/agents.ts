import { z } from "zod";
import { Fault, admin, agentAllowed, audit } from "../domain/model.js";
import { page, params, uuid } from "./validation.js";
import { PersonalService } from "../domain/personal-service.js";
import { digest } from "../domain/service.js";
import type { RouteContext } from "./context.js";

export function registerAgentsRoutes({
  app,
  actor,
  service,
  configurationStore,
  agentKey,
}: Pick<
  RouteContext,
  "app" | "actor" | "service" | "configurationStore" | "agentKey"
>) {
  app.get("/api/v1/agents", async (req) => {
    const a = actor(req),
      p = page.parse(req.query);
    return service.store.readMetadata(
      a.tenantId,
      ["agents", "managedAgents", "logicalAgents"],
      (s) => ({
        items: (service instanceof PersonalService
          ? Object.values(s.managedAgents ?? {})
          : Object.values(s.agents)
        )
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
    if (service instanceof PersonalService)
      return service.registry.read((s) => ({
        items: Object.values(s.managedAgents ?? {})
          .slice(p.offset, p.offset + p.limit)
          .map((v) => ({
            ...v,
            agentId: v.id,
            activeVersionId: v.id,
            publishedAt: v.updatedAt,
            digest: digest(v.config),
          })),
      }));
    return configurationStore.readMetadata(
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
    const key = agentKey(params(req.params).id);
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return configurationStore.tx(a.tenantId, (s) => {
      const agent =
        service instanceof PersonalService
          ? s.managedAgents?.[key]
          : s.agents[key];
      if (!agent) throw new Fault(404, "AGENT_NOT_FOUND");
      agent.enabled = b.enabled;
      if (service instanceof PersonalService) {
        s.configRevisions ??= { global: 0, agents: 0 };
        s.configRevisions.agents++;
      }
      audit(s, a, "agent.status", key);
      return agent;
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
        agentKey(params(req.params).id),
        b.allowedUsers,
      );
    });
  }
}
