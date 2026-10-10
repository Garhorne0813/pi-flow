# Fault and load acceptance

Use a dedicated disposable PostgreSQL 17 database. Scripts apply all migrations
and remove their own randomly named tenant; never point them at production.

```sh
export TEST_DATABASE_URL=postgres://harness:test-only@localhost:5432/harness_test
node --import tsx scripts/acceptance/worker-crash.ts
for n in 10 100 500; do
  SSE_CLIENTS=$n node --import tsx scripts/acceptance/sse-load.ts
done
```

The crash scenario launches two actual Worker processes, checks that only one
executes a Run, persists a checkpoint, kills its owner with SIGKILL, accelerates
its persisted lease expiry, and lets the surviving Worker recover it. It asserts
one terminal failure, no lease, unchanged checkpoint and no replay. The runtime
is deliberately stalled and the sandbox is a demo adapter: this does not prove
remote tool outcomes or real Cube cleanup.

The load scenario opens actual HTTP SSE connections against the real API and
PostgreSQL, writes 20 timed events, checks every client sees the exact ordered
history once, and reconnects with Last-Event-ID. JSON reports include delivery
P95/P99, process CPU, peak RSS and elapsed time. It measures one hot Run and uses
synthetic events, not model tokens or production latency. CI retains reports for
10/100/500 connections. No environment-independent latency SLO is claimed.

## Required real-provider gate (not yet executed)

Issue #18 remains open until this gate passes on the deployment's actual Cube,
MCP and gateway. No credentials or real-provider results are bundled here.
Record commit, SDK/provenance hashes, database version, worker/API replica count,
provider versions, UTC timestamps, sanitized request IDs, resource inventory
before/after and P95/P99 metrics. Never record tokens, credentials or tool text.

Run a dedicated test tenant with restricted grants and quotas. Verify normal
remote file persistence, writable /workspace, read-only /skills, and MCP success.
Then repeat with two workers and these controlled faults:

| Fault | Required evidence |
| --- | --- |
| Kill worker during Cube create, after dispatch and before SID persistence | Capacity remains reserved/unknown; inventory reconciler recovers only positively owned resources; eventual cleanup is confirmed |
| Kill worker during remote tool execution | Run fails with unknown outcome; remote side effects are not retried |
| MCP disconnect after dispatch or missing response | Attempt marked unknown; approval and idempotency evidence retained; no automatic replay |
| Cube create/kill timeout and pause/resume failure | Ambiguous capacity is not freed by age; late cleanup and retry do not touch a newer generation |
| API/PostgreSQL outage during SSE | Health fails within its deadline; reconnect preserves event order and ACL checks |
| Parent cancellation, user/agent revocation and token expiry | Subagent/tool dispatch stops; stream closes; foreign tenant sees no resource |
| Rolling worker shutdown under 10/100/500 subscribers | No duplicate claim; queued work resumes; active unknown work does not replay; cleanup confirmed |

Repeat reconnect and fault scenarios at each concurrency level, with actual
model deltas and MCP/Cube operations. Confirm provider-side inventory returns to
baseline, global/user capacity is correct, session entries are recoverable and
usage reservations survive failures. Compare CPU/RSS, database pool waits,
statement latency, delivery latency and resource leaks against a recorded
baseline and deployment SLO. Store raw sanitized evidence and a signed-off
pass/fail table; mock/synthetic successes must not satisfy this gate.
