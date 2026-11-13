import assert from "node:assert/strict";
import test from "node:test";
import { Fault } from "../src/domain/model.js";
import { streamErrorCode } from "../src/api/events.js";
test("SSE separates transient outages from revoked access and expiry", () => {
  assert.equal(
    streamErrorCode(new Error("database offline")),
    "STREAM_UNAVAILABLE",
  );
  assert.equal(
    streamErrorCode(new Fault(503, "DATABASE_UNAVAILABLE")),
    "STREAM_UNAVAILABLE",
  );
  assert.equal(
    streamErrorCode(new Fault(401, "UNAUTHENTICATED")),
    "AUTHENTICATION_EXPIRED",
  );
  assert.equal(
    streamErrorCode(new Fault(403, "USER_DISABLED")),
    "ACCESS_REVOKED",
  );
  assert.equal(
    streamErrorCode(new Fault(404, "RUN_NOT_FOUND")),
    "ACCESS_REVOKED",
  );
});
