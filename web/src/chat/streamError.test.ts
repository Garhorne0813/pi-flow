import { expect, it } from "vitest";
import { streamError } from "./streamError";
it("only stops retries for explicit authentication/authorization errors", () => {
  expect(streamError('{"code":"AUTHENTICATION_EXPIRED"}').status).toBe(401);
  expect(streamError('{"code":"ACCESS_REVOKED"}').status).toBe(403);
  for (const code of [
    "STREAM_UNAVAILABLE",
    "ACCESS_REVOKED_OR_UNAVAILABLE",
    "UNKNOWN",
  ])
    expect(streamError(JSON.stringify({ code })).status).toBe(503);
  expect(streamError("invalid")).toMatchObject({ status: 503 });
});
