import type { State } from "../domain/model.js";
import { alerts } from "../observability/alerts.js";
import { admin, run } from "../domain/model.js";
import { bounded } from "../observability/health.js";
import { telemetry } from "../observability/telemetry.js";
import { usageReport, policyFromEnv } from "../domain/usage.js";
import { page, params, uuid } from "./validation.js";
import { z } from "zod";
import { Fault } from "../domain/model.js";
import type { RouteContext } from "./context.js";

export function registerOperationsRoutes({
  app,
  actor,
  service,
}: Pick<RouteContext, "app" | "actor" | "service">) {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/v1/admin/usage", async (req) => {
    const a = actor(req);
    admin(a);
    return service.store.readUsage
      ? service.store.readUsage(a.tenantId, undefined, (s) =>
          usageReport(s, policyFromEnv()),
        )
      : service.store.readMetadata(a.tenantId, ["usage", "workspaces"], (s) =>
          usageReport(s, policyFromEnv()),
        );
  });
  app.get("/api/v1/usage", async (req) => {
    const a = actor(req);
    return service.store.readUsage
      ? service.store.readUsage(a.tenantId, undefined, (s) =>
          usageReport(s, policyFromEnv(), a.userId),
        )
      : service.store.readMetadata(a.tenantId, ["usage", "workspaces"], (s) =>
          usageReport(s, policyFromEnv(), a.userId),
        );
  });
  app.get("/api/v1/runs/:id/usage", async (req) => {
    const a = actor(req),
      rid = uuid.parse(params(req.params).id);
    const read = <T>(fn: (s: State) => T) =>
      service.store.readUsage
        ? service.store.readUsage(a.tenantId, rid, fn)
        : service.store.read(a.tenantId, fn);
    return read((s) => {
      run(s, a, rid);
      return usageReport(s, policyFromEnv(), undefined, rid);
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
  app.get("/api/v1/admin/audit", async (req) => {
    const a = actor(req);
    admin(a);
    const p = page
      .extend({ cursor: z.string().max(2000).optional() })
      .parse(req.query);
    let after: { timestamp: string; id: string } | undefined;
    if (p.cursor !== undefined) {
      try {
        after = z
          .object({
            timestamp: z.string().datetime(),
            id: z.string().min(1).max(200),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(p.cursor, "base64url").toString()));
      } catch {
        throw new Fault(400, "INVALID_CURSOR");
      }
      if (p.offset) throw new Fault(400, "INVALID_CURSOR");
    }
    const rows = service.store.listAudit
      ? await service.store.listAudit(a.tenantId, p.offset, p.limit + 1, after)
      : await service.store.readMetadata(a.tenantId, ["audit"], (s) =>
          s.audit
            .sort((a, b) =>
              a.timestamp < b.timestamp
                ? -1
                : a.timestamp > b.timestamp
                  ? 1
                  : a.id < b.id
                    ? -1
                    : a.id > b.id
                      ? 1
                      : 0,
            )
            .filter(
              (r) =>
                !after ||
                r.timestamp > after.timestamp ||
                (r.timestamp === after.timestamp && r.id > after.id),
            )
            .slice(p.offset, p.offset + p.limit + 1),
        );
    const items = rows.slice(0, p.limit),
      last = items.at(-1);
    return {
      items,
      ...(rows.length > p.limit && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ timestamp: last.timestamp, id: last.id }),
            ).toString("base64url"),
          }
        : {}),
    };
  });
  app.get("/api/v1/admin/stats", async (req) => {
    const a = actor(req);
    admin(a);
    if (service.store.adminStats) return service.store.adminStats(a.tenantId);
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
}
