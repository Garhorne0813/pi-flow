import { report, compare } from "../evals/report.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { Fault, type Actor } from "../domain/model.js";
import { Page, type EvalService } from "../evals/service.js";
const params = z.object({ id: z.uuid() });
export function registerEvalJobRoutes(
  app: FastifyInstance,
  actor: (req: object) => Actor,
  service: EvalService,
) {
  const root = "/api/v1/evals";
  app.get(root + "/jobs/:id/report", async (req) => {
    const a = actor(req),
      id = params.parse(req.params).id;
    const job = await service.authorizeJob(a, id);
    return report(
      job,
      await service
        .jobStore()
        .caseRuns(a.userId, id, { offset: 0, limit: 100 }),
      await service.jobStore().usage(a.userId, id),
    );
  });
  app.post(root + "/compare", async (req) => {
    const a = actor(req);
    const p = z
      .object({ baselineJobId: z.uuid(), candidateJobId: z.uuid() })
      .strict()
      .parse(req.body);
    const baseline = await service.authorizeJob(a, p.baselineJobId),
      candidate = await service.authorizeJob(a, p.candidateJobId);
    return compare(
      baseline,
      candidate,
      await service
        .jobStore()
        .caseRuns(a.userId, p.baselineJobId, { offset: 0, limit: 100 }),
      await service
        .jobStore()
        .caseRuns(a.userId, p.candidateJobId, { offset: 0, limit: 100 }),
    );
  });
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
    const rows = await service.jobStore().jobs(a.userId, Page.parse(req.query));
    const visible = [];
    for (const job of rows) {
      try {
        await service.jobStore().access.authorize(job);
        visible.push(job);
      } catch (error) {
        if (!(error instanceof Fault && error.status === 403)) throw error;
      }
    }
    return visible;
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
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      closed = true;
      clearInterval(timer);
      clearTimeout(expiryTimer);
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
        else if (!reply.raw.write(": heartbeat\n\n")) {
          reply.raw.destroy();
          close();
        }
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
    let checking = false;
    const timer = setInterval(() => {
      if (!checking) {
        checking = true;
        void service
          .authorizeJob(a, id)
          .catch(() => close())
          .finally(() => {
            checking = false;
          });
      }
      void poll();
    }, 1000);
    if (a.expiresAt !== undefined)
      expiryTimer = setTimeout(
        () => {
          reply.raw.destroy();
          close();
        },
        Math.min(2147483647, Math.max(0, a.expiresAt - Date.now())),
      );
    reply.raw.once("close", () => {
      closed = true;
      clearInterval(timer);
      clearTimeout(expiryTimer);
    });
    await poll();
  });
}
