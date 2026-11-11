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
    const i = next.items.findIndex((x) => x.id === item.id);
    if (i < 0) next.items.push(item);
    else next.items[i] = { ...next.items[i], ...item };
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
    next.items = next.items.map((x) =>
      x.interactionId === str(d.interactionId) ? { ...x, resolved: true } : x,
    );
  if (e.type === "run.failed" || e.type === "run.cancelled")
    upsert({
      id: `event:${e.eventId}`,
      kind: "notice",
      runId: e.runId,
      text: e.type,
    });
  return next;
}
export function mergeHistory(items: Item[]): Item[] {
  const result: Item[] = [];
  for (const item of items) {
    if (item.kind === "resolved") {
      for (const x of result)
        if (x.interactionId === item.interactionId) x.resolved = true;
      continue;
    }
    const previous = result.find((x) =>
      item.kind === "tool"
        ? x.kind === "tool" &&
          x.runId === item.runId &&
          x.callId === item.callId
        : item.kind === "interaction"
          ? x.interactionId === item.interactionId
          : x.id === item.id,
    );
    if (previous)
      Object.assign(previous, { ...item, name: item.name || previous.name });
    else result.push({ ...item });
  }
  return result;
}
