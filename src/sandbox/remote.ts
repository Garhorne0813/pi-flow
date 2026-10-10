import { Fault } from "../domain.js";
export function remote<T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
  late?: (value: T) => Promise<void>,
  timeout = 30000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const stop = (error: unknown) => {
      if (settled) return;
      settled = abandoned = true;
      clean();
      reject(error);
    };
    const abort = () => stop(signal?.reason);
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => stop(new Fault(504, "SANDBOX_REMOTE_TIMEOUT")),
      timeout,
    );
    Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return start();
      })
      .then(
        (value) => {
          if (abandoned) {
            if (late) void late(value).catch(() => {});
            return;
          }
          settled = true;
          clean();
          resolve(value);
        },
        (error) => {
          if (!settled) {
            settled = true;
            clean();
            reject(error);
          }
        },
      );
  });
}
