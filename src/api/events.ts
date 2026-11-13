import { z } from "zod";
import { Fault, run } from "../domain/model.js";
import { telemetry } from "../observability/telemetry.js";
import { params, uuid } from "./validation.js";
import { principal } from "../storage/registry.js";
import type { RouteContext } from "./context.js";

export function streamErrorCode(error: unknown) {
  if (error instanceof Fault && error.status === 401)
    return "AUTHENTICATION_EXPIRED";
  if (error instanceof Fault && [403, 404].includes(error.status))
    return "ACCESS_REVOKED";
  return "STREAM_UNAVAILABLE";
}
export function registerEventsRoutes({
  app,
  actor,
  service,
}: Pick<RouteContext, "app" | "actor" | "service">) {
  app.get("/api/v1/runs/:id/events", async (req, reply) => {
    const a = actor(req),
      rid = uuid.parse(params(req.params).id);
    const q = z
      .object({ after: z.coerce.number().int().min(0).optional() })
      .parse(req.query);
    let cursor =
      q.after ??
      z.coerce
        .number()
        .int()
        .min(0)
        .parse(req.headers["last-event-id"] ?? 0);
    await service.store.eventPage(
      a.tenantId,
      rid,
      cursor,
      0,
      (s) => run(s, a, rid).state,
    );
    const subscription = await service.store.watchEvents?.(a.tenantId, rid);
    if (a.expiresAt !== undefined && Date.now() >= a.expiresAt) {
      subscription?.close();
      throw new Fault(401, "AUTHENTICATION_EXPIRED");
    }
    reply.hijack();
    telemetry.count("sse_active", 1);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-ID": req.id,
    });
    let closed = false;
    const disconnected = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const expired = () =>
      a.expiresAt !== undefined && Date.now() >= a.expiresAt;
    const closeStream = (code: string) => {
      if (closed) return;
      closed = true;
      disconnected.abort();
      // A stalled reader may prevent end() from flushing and emitting close.
      // Destroy a backpressured response so revocation/expiry releases the waiter.
      if (reply.raw.writableNeedDrain) reply.raw.destroy();
      else
        reply.raw.end(
          `event: stream.error\ndata: ${JSON.stringify({ code })}\n\n`,
        );
    };
    const expire = () => closeStream("AUTHENTICATION_EXPIRED");
    let checkingActor = false;
    const checkActor = async () => {
      if (closed || checkingActor) return;
      checkingActor = true;
      try {
        await service.verifyActor(a);
      } catch (error) {
        closeStream(streamErrorCode(error));
      } finally {
        checkingActor = false;
      }
    };
    // Independent of event paging/backpressure: disabled accounts lose even
    // idle or stalled connections within one second plus identity lookup time.
    const actorTimer = setInterval(() => {
      void checkActor();
    }, 1000);
    const armExpiry = () => {
      if (a.expiresAt === undefined || closed) return;
      const remaining = a.expiresAt - Date.now();
      if (remaining <= 0) return expire();
      expiryTimer = setTimeout(
        () => {
          if (expired()) expire();
          else armExpiry();
        },
        Math.min(remaining, 2147483647),
      );
    };
    reply.raw.on("close", () => {
      closed = true;
      clearTimeout(expiryTimer);
      clearInterval(actorTimer);
      disconnected.abort();
      subscription?.close();
      telemetry.count("sse_active", -1);
    });
    armExpiry();
    let lastBeat = Date.now();
    try {
      while (!closed) {
        if (expired()) {
          expire();
          break;
        }
        const batch = await service.store.eventPage(
          a.tenantId,
          rid,
          cursor,
          100,
          (s) => run(s, a, rid).state,
        );
        if (expired()) expire();
        if (closed) break;
        for (const e of batch.events) {
          // A database read or backpressure wait may cross the JWT deadline.
          if (expired()) expire();
          if (closed) break;
          cursor = e.eventId;
          if (
            !reply.raw.write(
              `id: ${e.eventId}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
            )
          ) {
            await new Promise<void>((resolve) => {
              const done = () => {
                reply.raw.off("drain", done);
                reply.raw.off("close", done);
                resolve();
              };
              reply.raw.once("drain", done);
              reply.raw.once("close", done);
            });
            if (closed) break;
          }
        }
        if (
          batch.events.length < 100 &&
          ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"].includes(
            batch.state,
          )
        )
          break;
        if (Date.now() - lastBeat > 15000) {
          reply.raw.write(": heartbeat\n\n");
          lastBeat = Date.now();
        }
        if (closed) break;
        if (batch.events.length === 100) {
          // Catch up immediately, while yielding between pages for other clients.
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        if (subscription) await subscription.wait(5000, disconnected.signal);
        else
          await service.store.waitForEvents(
            a.tenantId,
            rid,
            250,
            disconnected.signal,
          );
      }
    } catch (error) {
      closeStream(streamErrorCode(error));
    } finally {
      closed = true;
      subscription?.close();
      clearInterval(actorTimer);
      clearTimeout(expiryTimer);
      reply.raw.end();
    }
  });
}
