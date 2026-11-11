import { z } from "zod";
import { Fault, workspace, audit } from "../domain/model.js";
import { page, params, uuid } from "./validation.js";
import type { RouteContext } from "./context.js";

export function registerWorkspacesRoutes({
  app,
  actor,
  service,
  sandbox,
}: Pick<RouteContext, "app" | "actor" | "service" | "sandbox">) {
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
}
