import { z } from "zod";
import { run, Fault, type Run } from "../domain/model.js";
import { traceContext } from "../observability/telemetry.js";
import { params, uuid } from "./validation.js";
import type { RouteContext } from "./context.js";

// Status APIs expose execution metadata, never the private Worker config snapshot.
function publicRun(r: Run | undefined) {
  if (!r) throw new Fault(404, "RUN_NOT_FOUND");
  return {
    id: r.id,
    sessionId: r.sessionId,
    agentVersionId: r.agentVersionId,
    agentId: r.agentId,
    cwd: r.cwd,
    model: r.model,
    configDigest: r.configDigest,
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
export function registerRunsRoutes({
  app,
  actor,
  service,
}: Pick<RouteContext, "app" | "actor" | "service">) {
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
          req.headers.authorization?.slice(7),
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
            req.headers.authorization?.slice(7),
          ),
        ),
      );
  });
}
