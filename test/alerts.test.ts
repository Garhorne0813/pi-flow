import test from "node:test";
import assert from "node:assert/strict";
import { alerts } from "../src/alerts.js";
test("new faults and unknown capacity alert conservatively without replay or repeating cumulative errors", () => {
  const previous = {
    worker_errors_total: 5,
    heartbeat_errors_total: 2,
    mcp_unknown_total: 1,
  };
  assert.deepEqual(alerts(previous, previous), []);
  const active = alerts(
    { ...previous, heartbeat_errors_total: 3, mcp_unknown_total: 2 },
    previous,
    2,
  );
  assert.equal(
    active.find((x) => x.rule === "heartbeat_failure")?.severity,
    "warning",
  );
  assert.equal(
    active.find((x) => x.rule === "mcp_unknown")?.severity,
    "critical",
  );
  assert.equal(active.find((x) => x.rule === "sandbox_unknown")?.value, 2);
  assert.match(
    active.find((x) => x.rule === "sandbox_unknown")!.action,
    /no_ttl_release/,
  );
  assert.deepEqual(
    alerts({}, previous),
    [],
    "counter reset is not new failures",
  );
});
