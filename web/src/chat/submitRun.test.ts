import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({ api }));
import { submitRun } from "./submitRun";
beforeEach(() => api.mockReset());
it("retains the first send's key after a lost response and deduplicates clicks", async () => {
  api.mockRejectedValueOnce(new Error("response lost"));
  await expect(submitRun("new-session", "hello")).rejects.toThrow(
    "response lost",
  );
  const key = api.mock.calls[0][3];
  let resolve!: (value: unknown) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const retry = submitRun("new-session", "hello");
  expect(submitRun("new-session", "hello")).toBe(retry);
  expect(api.mock.calls[1][3]).toBe(key);
  resolve({ id: "run-1" });
  await retry;
  api.mockResolvedValueOnce({ id: "run-2" });
  await submitRun("new-session", "hello");
  expect(api.mock.calls[2][3]).not.toBe(key);
});
it("isolates pending keys and inflight responses across identity boundaries", async () => {
  const { resetSendScope } = await import("./submitRun");
  resetSendScope();
  let resolve!: (value: unknown) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const old = submitRun("shared-session", "same message");
  const oldKey = api.mock.calls[0][3],
    signal = api.mock.calls[0][4];
  resetSendScope();
  expect(signal.aborted).toBe(true);
  api.mockRejectedValueOnce(new Error("new response lost"));
  await expect(submitRun("shared-session", "same message")).rejects.toThrow(
    "new response lost",
  );
  const newKey = api.mock.calls[1][3];
  expect(newKey).not.toBe(oldKey);
  const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
  resolve({ id: "old-run" });
  await rejected;
  api.mockResolvedValueOnce({ id: "new-run" });
  await submitRun("shared-session", "same message");
  expect(api.mock.calls[2][3]).toBe(newKey);
});
it("retries creation with the same client ID after a lost response", async () => {
  const { createSession, resetSendScope } = await import("./submitRun");
  resetSendScope();
  api.mockRejectedValueOnce(new Error("response lost"));
  const input = { agentId: "one", title: "hello" };
  await expect(createSession(input, "hello")).rejects.toThrow("response lost");
  const id = api.mock.calls[0][1].id;
  api.mockResolvedValueOnce({ id });
  await createSession(input, "hello");
  expect(api.mock.calls[1][1].id).toBe(id);
  api.mockResolvedValueOnce({ id: "next" });
  await createSession(input, "hello");
  expect(api.mock.calls[2][1].id).not.toBe(id);
});
