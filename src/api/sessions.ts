import type { State } from "../domain/model.js";
import { z } from "zod";
import { workspace, session } from "../domain/model.js";
import { page, params, uuid } from "./validation.js";
import type { RouteContext } from "./context.js";

export function registerSessionsRoutes({
  app,
  actor,
  service,
}: Pick<RouteContext, "app" | "actor" | "service">) {
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
    const read = service.store.readSession
      ? <T>(fn: (s: State) => T) =>
          service.store.readSession!(a.tenantId, sid, fn)
      : <T>(fn: (s: State) => T) => service.store.read(a.tenantId, fn);
    return read((s) => ({
      ...session(s, a, sid),
      todos: s.todos[sid] ?? [],
    }));
  });
}
