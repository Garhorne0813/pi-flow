import { z } from "zod";
import { session, Fault, type State } from "../domain/model.js";
import type { RouteContext } from "./context.js";

const record = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" ? (x as Record<string, unknown>) : {};
const text = (x: unknown, max = 32000) =>
  typeof x === "string" ? x.slice(0, max) : "";
export function messageText(x: unknown) {
  const m = record(x);
  if (m.role !== "assistant") return "";
  return typeof m.content === "string"
    ? text(m.content)
    : Array.isArray(m.content)
      ? m.content
          .filter((c) => record(c).type === "text")
          .map((c) => text(record(c).text))
          .join("")
          .slice(0, 32000)
      : "";
}
// Explicit allowlist: no tool arguments/results, config snapshots, or token refs.
export function chatItem(source: unknown) {
  const e = record(source),
    d = record(e.data),
    base = {
      id: `event:${e.eventId}`,
      runId: text(e.runId),
      createdAt: text(e.timestamp),
    };
  if (e.kind === "user") return e;
  switch (e.type) {
    case "message.completed":
      return { ...base, kind: "assistant", text: messageText(d.message) };
    case "tool.started":
    case "tool.completed":
    case "tool.failed":
      return {
        ...base,
        kind: "tool",
        callId: text(d.callId),
        name: text(d.name, 100),
        state: String(e.type).split(".")[1],
      };
    case "interaction.required": {
      const i = record(d.interaction),
        p = record(i.payload);
      return {
        ...base,
        kind: "interaction",
        interactionId: text(i.id),
        interactionKind: i.kind === "approval" ? "approval" : "question",
        text: text(p.question ?? p.description ?? p.message ?? p.name, 16000),
        resolved: false,
      };
    }
    case "interaction.resolved":
      return {
        ...base,
        kind: "resolved",
        interactionId: text(d.interactionId),
      };
    default:
      return { ...base, kind: "notice", text: text(e.type, 100) };
  }
}
export function registerChatRoutes({
  app,
  actor,
  service,
}: Pick<RouteContext, "app" | "actor" | "service">) {
  const authorize = async (req: object, sid: string) => {
    const a = actor(req);
    const read = service.store.readSession
      ? <T>(fn: (s: State) => T) =>
          service.store.readSession!(a.tenantId, sid, fn)
      : <T>(fn: (s: State) => T) => service.store.read(a.tenantId, fn);
    await read((s) => session(s, a, sid));
    return a;
  };
  app.get("/api/v1/sessions/:id/timeline", async (req) => {
    const sid = z.object({ id: z.string().uuid() }).parse(req.params).id,
      a = await authorize(req, sid);
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(2048).optional(),
      })
      .parse(req.query);
    let before: [string, string] | undefined;
    if (q.cursor) {
      try {
        before = z
          .tuple([z.string(), z.string()])
          .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString()));
      } catch {
        throw new Fault(400, "INVALID_CURSOR");
      }
    }
    const page = service.store.chatSources
      ? await service.store.chatSources(a.tenantId, sid, q.limit, before)
      : await service.store.read(a.tenantId, (s) => {
          session(s, a, sid);
          const rows = [
            ...Object.values(s.runs)
              .filter(
                (r) =>
                  r.sessionId === sid &&
                  !r.parentRunId &&
                  !r.resumedFrom &&
                  !r.schedule,
              )
              .map((r) => ({
                at: r.createdAt,
                id: "run:" + r.id,
                item: {
                  kind: "user",
                  id: "run:" + r.id,
                  runId: r.id,
                  taskId: r.taskId,
                  text: r.prompt.slice(0, 32000),
                  createdAt: r.createdAt,
                },
              })),
            ...s.events
              .filter(
                (e) =>
                  e.sessionId === sid &&
                  [
                    "message.completed",
                    "tool.started",
                    "tool.completed",
                    "tool.failed",
                    "interaction.required",
                    "interaction.resolved",
                    "run.failed",
                    "run.cancelled",
                    "subagent.completed",
                  ].includes(e.type),
              )
              .map((e) => ({
                at: e.timestamp,
                id: "event:" + e.eventId,
                item: e,
              })),
          ]
            .filter(
              (r) =>
                !before ||
                r.at < before[0] ||
                (r.at === before[0] && r.id < before[1]),
            )
            .sort((a, b) =>
              a.at < b.at
                ? 1
                : a.at > b.at
                  ? -1
                  : a.id < b.id
                    ? 1
                    : a.id > b.id
                      ? -1
                      : 0,
            );
          const selected = rows.slice(0, q.limit);
          return {
            rows: selected,
            next:
              rows.length > q.limit
                ? [selected.at(-1)!.at, selected.at(-1)!.id]
                : null,
          };
        });
    return {
      items: page.rows.reverse().map((r) => chatItem(r.item)),
      nextCursor: page.next
        ? Buffer.from(JSON.stringify(page.next)).toString("base64url")
        : null,
    };
  });
  app.get("/api/v1/sessions/:id/active-task", async (req) => {
    const sid = z.object({ id: z.string().uuid() }).parse(req.params).id,
      a = await authorize(req, sid);
    const activeRun = service.store.activeChatTask
      ? await service.store.activeChatTask(a.tenantId, sid)
      : await service.store.read(a.tenantId, (s) => {
          session(s, a, sid);
          const r = Object.values(s.runs).find(
            (r) =>
              r.sessionId === sid &&
              !r.parentRunId &&
              ["QUEUED", "RUNNING", "WAITING_INPUT"].includes(r.state),
          );
          return r
            ? {
                id: r.id,
                state: r.state,
                taskId: r.taskId,
                createdAt: r.createdAt,
              }
            : null;
        });
    return { sessionId: sid, taskId: activeRun?.taskId ?? null, activeRun };
  });
}
