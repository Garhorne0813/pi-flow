import { z } from "zod";
export const EventSchema = z.object({
  eventId: z.number().int().nonnegative(),
  runId: z.string(),
  sessionId: z.string(),
  type: z.string(),
  timestamp: z.string(),
  data: z.unknown(),
});
export type PiEvent = z.infer<typeof EventSchema>;
export interface Item {
  id: string;
  eventId?: number;
  kind: string;
  runId: string;
  text?: string;
  createdAt?: string;
  callId?: string;
  name?: string;
  state?: string;
  interactionId?: string;
  interactionKind?: string;
  resolved?: boolean;
}
export interface Projection {
  items: Item[];
  cursors: Record<string, number>;
  drafts: Record<string, string>;
}
export const empty: Projection = { items: [], cursors: {}, drafts: {} };
export const object = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" ? (x as Record<string, unknown>) : {};
const str = (x: unknown) => (typeof x === "string" ? x : "");
export function messageText(x: unknown) {
  const m = object(x);
  return m.role === "assistant"
    ? typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .filter((c) => object(c).type === "text")
            .map((c) => str(object(c).text))
            .join("")
        : ""
    : "";
}
export function reduce(s: Projection, e: PiEvent): Projection {
  if (e.eventId <= (s.cursors[e.runId] || 0)) return s;
  const next = {
      ...s,
      items: [...s.items],
      cursors: { ...s.cursors, [e.runId]: e.eventId },
      drafts: { ...s.drafts },
    },
    d = object(e.data);
  const upsert = (item: Item) => {
    next.items = mergeHistory([...next.items, { ...item, eventId: e.eventId }]);
  };
  if (e.type === "message.delta")
    next.drafts[e.runId] = (next.drafts[e.runId] || "") + str(d.delta);
  if (e.type === "message.completed") {
    delete next.drafts[e.runId];
    upsert({
      id: `event:${e.eventId}`,
      kind: "assistant",
      runId: e.runId,
      text: messageText(d.message),
      createdAt: e.timestamp,
    });
  }
  if (e.type.startsWith("tool.")) {
    // The live API doesn't guarantee safe arguments/results. Display status only.
    const previous = next.items.find(
      (x) =>
        x.kind === "tool" && x.runId === e.runId && x.callId === str(d.callId),
    );
    upsert({
      id: previous?.id || `tool:${e.runId}:${str(d.callId)}`,
      kind: "tool",
      runId: e.runId,
      callId: str(d.callId),
      name: str(d.name) || previous?.name,
      state: e.type.split(".")[1],
    });
  }
  if (e.type === "interaction.required") {
    const i = object(d.interaction),
      p = object(i.payload);
    upsert({
      id: `interaction:${str(i.id)}`,
      kind: "interaction",
      runId: e.runId,
      interactionId: str(i.id),
      interactionKind: str(i.kind),
      text: str(p.question || p.description || p.message || p.name),
    });
  }
  if (e.type === "interaction.resolved")
    upsert({
      id: `event:${e.eventId}`,
      kind: "resolved",
      runId: e.runId,
      interactionId: str(d.interactionId),
    });
  if (e.type === "run.failed" || e.type === "run.cancelled")
    upsert({
      id: `event:${e.eventId}`,
      kind: "notice",
      runId: e.runId,
      text: e.type,
    });
  return next;
}
// Timeline IDs encode the source event sequence; live items carry it explicitly.
export const sequence = (item: Item) =>
  item.eventId ?? (/^event:\d+$/.test(item.id) ? Number(item.id.slice(6)) : 0);
const interactionKey = (item: Item) =>
  JSON.stringify([item.runId, item.interactionId]);
export function mergeHistory(items: Item[]): Item[] {
  const result: Item[] = [];
  const resolutions = new Map<string, Item>();
  for (const item of items) {
    if (
      item.kind === "resolved" ||
      (item.kind === "interaction" && item.resolved)
    ) {
      const key = interactionKey(item);
      const previous = resolutions.get(key);
      if (!previous || sequence(item) > sequence(previous))
        resolutions.set(key, item);
    }
    if (item.kind === "resolved") continue;
    const previous = result.find((x) =>
      item.kind === "tool"
        ? x.kind === "tool" &&
          x.runId === item.runId &&
          x.callId === item.callId
        : item.kind === "interaction"
          ? x.kind === "interaction" &&
            interactionKey(x) === interactionKey(item)
          : x.runId === item.runId && x.id === item.id,
    );
    if (previous) {
      const newer = sequence(item) >= sequence(previous) ? item : previous;
      const older = newer === item ? previous : item;
      Object.assign(previous, {
        ...older,
        ...newer,
        eventId: sequence(newer),
        name: newer.name || older.name,
      });
    } else result.push({ ...item, eventId: sequence(item) });
  }
  for (const item of result) {
    if (item.kind === "interaction" && resolutions.has(interactionKey(item))) {
      item.resolved = true;
      resolutions.delete(interactionKey(item));
    }
  }
  // Keep unmatched resolutions until an older page supplies their request.
  // These markers are projection metadata and never render as messages.
  for (const item of resolutions.values())
    if (item.kind === "resolved") result.push({ ...item });
  return result;
}
