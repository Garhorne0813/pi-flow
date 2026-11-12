import { api } from "../api/client";
// Keep an uncertain operation across route changes and retries, until acknowledged.
const pending = new Map<string, { text: string; key: string }>();
const inflight = new Map<string, Promise<unknown>>();
export function submitRun<T>(sid: string, text: string): Promise<T> {
  const running = inflight.get(sid);
  if (running) return running as Promise<T>;
  const previous = pending.get(sid);
  const operation =
    previous?.text === text ? previous : { text, key: crypto.randomUUID() };
  pending.set(sid, operation);
  const result = api<T>(
    `/sessions/${sid}/runs`,
    { message: text },
    "POST",
    operation.key,
  )
    .then((value) => {
      pending.delete(sid);
      return value;
    })
    .finally(() => {
      inflight.delete(sid);
    });
  inflight.set(sid, result);
  return result;
}
