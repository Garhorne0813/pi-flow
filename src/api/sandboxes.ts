import { z } from "zod";
import { params, uuid } from "./validation.js";
import type { RouteContext } from "./context.js";

export function registerSandboxesRoutes({
  app,
  actor,
  sandbox,
}: Pick<RouteContext, "app" | "actor" | "sandbox">) {
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
}
