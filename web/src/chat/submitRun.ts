import { api } from "../api/client";
// Keep an uncertain operation across route changes and retries, until acknowledged.
const newScope = () => ({
  pending: new Map<string, { text: string; key: string }>(),
  inflight: new Map<string, Promise<unknown>>(),
  controller: new AbortController(),
});
let scope = newScope();
export const sendScope = () => scope;
export function resetSendScope() {
  scope.controller.abort();
  scope = newScope();
}
export function submitRun<T>(sid: string, text: string): Promise<T> {
  const context = scope;
  const { pending, inflight } = context;
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
    context.controller.signal,
  )
    .then((value) => {
      if (context !== scope)
        throw new DOMException("Identity changed", "AbortError");
      pending.delete(sid);
      return value;
    })
    .finally(() => {
      inflight.delete(sid);
    });
  inflight.set(sid, result);
  return result;
}
