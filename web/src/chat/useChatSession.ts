import { useEffect, useRef, useState } from "react";
import { api, ApiError, request } from "../api/client";
import { parseSSE } from "../api/sse";
import {
  empty,
  EventSchema,
  mergeHistory,
  reduce,
  type Item,
  type Projection,
} from "./model";
export interface Run {
  id: string;
  state: string;
  taskId?: string;
}
const terminal = (r: Run) =>
  ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"].includes(r.state);
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
export function useChatSession(sid: string | undefined) {
  const [projection, setProjection] = useState<Projection>(empty),
    [run, setRun] = useState<Run | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [cursor, setCursor] = useState<string | null>(null);
  const state = useRef(empty),
    generation = useRef(0),
    locked = useRef(false),
    pending = useRef<{ key: string; text: string } | null>(null);
  function update(fn: (p: Projection) => Projection) {
    state.current = fn(state.current);
    setProjection(state.current);
  }
  async function history(id: string, older?: string) {
    const page = await api<{ items: Item[]; nextCursor: string | null }>(
      `/sessions/${id}/timeline${older ? "?cursor=" + encodeURIComponent(older) : ""}`,
    );
    if (id !== currentSid.current) return;
    setCursor(page.nextCursor);
    update((p) => {
      const cursors = { ...p.cursors };
      for (const item of page.items) {
        if (item.id.startsWith("event:"))
          cursors[item.runId] = Math.max(
            cursors[item.runId] || 0,
            Number(item.id.slice(6)),
          );
      }
      return {
        ...p,
        cursors,
        items: mergeHistory(
          older ? [...page.items, ...p.items] : [...p.items, ...page.items],
        ),
      };
    });
  }
  const currentSid = useRef(sid);
  currentSid.current = sid;
  useEffect(() => {
    const gen = ++generation.current,
      controller = new AbortController();
    state.current = empty;
    setProjection(empty);
    setRun(null);
    setError("");
    setCursor(null);
    pending.current = null;
    if (!sid) return;
    async function sync() {
      while (!controller.signal.aborted && gen === generation.current) {
        try {
          const active = await api<{ activeRun: Run | null }>(
            `/sessions/${sid}/active-task`,
          );
          if (controller.signal.aborted) return;
          setRun(active.activeRun);
          if (!active.activeRun) {
            await history(sid!);
            await delay(2500, controller.signal);
            continue;
          }
          const r = active.activeRun;
          const res = await request(
            `/runs/${r.id}/events?after=${state.current.cursors[r.id] || 0}`,
            { signal: controller.signal },
          );
          for await (const frame of parseSSE(res.body!, controller.signal)) {
            if (gen !== generation.current) return;
            if (frame.event === "stream.error")
              throw new ApiError(401, "AUTHENTICATION_EXPIRED_OR_REVOKED");
            const event = EventSchema.parse(JSON.parse(frame.data));
            if (event.runId !== r.id || event.sessionId !== sid)
              throw new Error("STREAM_IDENTITY_MISMATCH");
            update((p) => reduce(p, event));
          }
          const status = await api<Run>(`/runs/${r.id}`);
          if (gen !== generation.current) return;
          setRun(status);
          if (terminal(status)) await history(sid!);
          await delay(
            status.state === "WAITING_INPUT" ? 2000 : 500,
            controller.signal,
          );
          setError("");
        } catch (e) {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : "连接失败");
          if (e instanceof ApiError && [401, 403, 404].includes(e.status))
            return;
          await delay(2500, controller.signal);
        }
      }
    }
    void history(sid)
      .then(sync)
      .catch((e) => setError(e.message));
    return () => controller.abort();
  }, [sid]);
  async function mutate(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function send(text: string) {
    if (!sid) return false;
    let sent = false;
    await mutate(async () => {
      const id = sid;
      const operation = async () => {
        pending.current =
          pending.current?.text === text
            ? pending.current
            : { key: crypto.randomUUID(), text };
        const r = await api<Run>(
          `/sessions/${id}/runs`,
          { message: text },
          "POST",
          pending.current.key,
        );
        pending.current = null;
        if (id !== currentSid.current) return;
        setRun(r);
        update((p) => ({
          ...p,
          items: mergeHistory([
            ...p.items,
            { id: `run:${r.id}`, kind: "user", runId: r.id, text },
          ]),
        }));
        sent = true;
      };
      if (navigator.locks)
        await navigator.locks.request(
          `pi-flow-send:${id}`,
          { ifAvailable: true },
          async (lock) => {
            if (lock) await operation();
          },
        );
      else await operation();
    });
    return sent;
  }
  const respond = (id: string, response: string) =>
    mutate(async () => {
      const r = await api<Run>(`/interactions/${id}/response`, { response });
      if (sid !== currentSid.current) return;
      setRun(r);
      update((p) => ({
        ...p,
        items: p.items.map((x) =>
          x.interactionId === id ? { ...x, resolved: true } : x,
        ),
      }));
    });
  const cancel = () =>
    mutate(async () => {
      if (run) setRun(await api<Run>(`/runs/${run.id}/cancel`, {}));
    });
  return {
    projection,
    run,
    error,
    busy,
    send,
    respond,
    cancel,
    loadOlder: () => (sid && cursor ? history(sid, cursor) : Promise.resolve()),
    hasOlder: !!cursor,
  };
}
