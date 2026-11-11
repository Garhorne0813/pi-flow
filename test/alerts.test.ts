import test from "node:test";
import assert from "node:assert/strict";
import { alerts } from "../src/observability/alerts.js";
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

test("collection commit and cleanup uncertainty alert on new events without replaying historical counters", () => {
  const counters = {
    skill_collections_commit_unconfirmed_total: 1,
    skill_collections_cleanup_unconfirmed_total: 2,
  };
  const active = alerts(counters);
  assert.equal(
    active.find((a) => a.rule === "skill_collection_commit_unknown")?.severity,
    "critical",
  );
  assert.equal(
    active.find((a) => a.rule === "skill_collection_cleanup_unknown")?.value,
    2,
  );
  assert.deepEqual(alerts(counters, counters), []);
});
