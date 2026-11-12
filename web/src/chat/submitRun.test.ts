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
