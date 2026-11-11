import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Actor } from "../domain/model.js";
import { Page, type EvalService } from "../evals/service.js";
const params = z.object({ id: z.uuid() });
export function registerEvalJobRoutes(
  app: FastifyInstance,
  actor: (req: object) => Actor,
  service: EvalService,
) {
  const root = "/api/v1/evals";
  app.post(root + "/jobs", async (req, reply) => {
    const a = actor(req);
    await service.authorize(a);
    const key = z
      .string()
      .min(1)
      .max(128)
      .parse(req.headers["idempotency-key"]);
    return reply
      .code(202)
      .send(await service.jobStore().create(a, req.body, key));
  });
  app.get(root + "/jobs", async (req) => {
    const a = actor(req);
    await service.authorize(a);
    return service.jobStore().jobs(a.userId, Page.parse(req.query));
  });
  app.get(root + "/jobs/:id", async (req) =>
    service.authorizeJob(actor(req), params.parse(req.params).id),
  );
  app.post(root + "/jobs/:id/cancel", async (req) => {
    const a = actor(req),
      id = params.parse(req.params).id;
    await service.authorizeJob(a, id);
    return service.jobStore().cancel(a.userId, id);
  });
  app.get(root + "/jobs/:id/cases", async (req) => {
    const a = actor(req),
      id = params.parse(req.params).id;
    await service.authorizeJob(a, id);
    return service.jobStore().caseRuns(a.userId, id, Page.parse(req.query));
  });
  app.get(root + "/jobs/:id/events", async (req, reply) => {
    const a = actor(req),
      id = params.parse(req.params).id;
    await service.authorizeJob(a, id);
    const q = z
      .object({ after: z.coerce.number().int().nonnegative().optional() })
      .parse(req.query);
    let cursor =
        q.after ??
        z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(req.headers["last-event-id"] ?? 0),
      closed = false,
      busy = false;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const close = () => {
      closed = true;
      clearInterval(timer);
      reply.raw.end();
    };
    const poll = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const job = await service.authorizeJob(a, id);
        if (closed) return;
        const events = await service.jobStore().events(a.userId, id, cursor);
        await service.authorizeJob(a, id);
        if (closed) return;
        for (const e of events) {
          if (
            !reply.raw.write(
              `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
            )
          ) {
            reply.raw.destroy();
            close();
            return;
          }
          cursor = e.eventId;
        }
        if (events.length < 100 && !["QUEUED", "RUNNING"].includes(job.state))
          close();
        else reply.raw.write(": heartbeat\n\n");
      } catch {
        if (!closed)
          reply.raw.write(
            'event: stream.error\ndata: {"code":"ACCESS_REVOKED_OR_UNAVAILABLE"}\n\n',
          );
        close();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    reply.raw.once("close", () => {
      closed = true;
      clearInterval(timer);
    });
    await poll();
  });
}
