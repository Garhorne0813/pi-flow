import { z } from "zod";
import { Fault, workspace, type Actor } from "../domain/model.js";
import { params, uuid } from "./validation.js";
import type { RouteContext } from "./context.js";

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
export function registerFilesRoutes({
  app,
  actor,
  service,
  sandbox,
}: Pick<RouteContext, "app" | "actor" | "service" | "sandbox">) {
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
}
