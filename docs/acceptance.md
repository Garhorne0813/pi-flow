# Layered acceptance and production release gate

[#18](https://github.com/Garhorne0813/pi-flow/issues/18) is the production
acceptance umbrella and a **production release blocker**. Track each layer's
completed evidence and remaining work separately. A missing real-provider test
environment does not invalidate the completed stages or count as a passed gate.

## Completed stages

| Layer | Evidence | Boundary |
| --- | --- | --- |
| Runtime/store and protocol regressions | PostgreSQL integration, local HTTPS MCP fault tests and Pi SDK with a local HTTP gateway | Local protocol servers and test adapters do not prove deployment endpoint behavior |
| Multiprocess crash recovery | Two actual Worker processes, real PostgreSQL, SIGKILL, durable checkpoint and no duplicate/replayed execution | Runtime is deliberately stalled, sandbox is Demo, persisted lease expiry is accelerated |
| SSE replay/load | Real HTTP API and PostgreSQL, 10/100/500 clients, ordered replay and Last-Event-ID reconnect | One hot Run and 20 synthetic events; no actual model delta workload or production SLO |

Use a dedicated disposable PostgreSQL 17 database. Scripts apply all migrations
and remove their own randomly named tenant; never point them at production.

```sh
export TEST_DATABASE_URL=postgres://harness:test-only@localhost:5432/harness_test
node --import tsx scripts/acceptance/worker-crash.ts
for n in 10 100 500; do
  SSE_CLIENTS=$n node --import tsx scripts/acceptance/sse-load.ts
done
```

The crash scenario checks that only one process executes a Run, persists a
checkpoint, kills its owner, accelerates the stored expiry, and lets the
surviving Worker recover it. It asserts one terminal failure, no lease,
unchanged checkpoint and no replay. Remote tool outcomes and Cube cleanup are
outside this scenario.

SSE JSON reports retain delivery P95/P99, process CPU, peak RSS and elapsed time.
CI saves reports for each concurrency. Measurements describe that commit,
dataset and environment; they do not establish a production connection limit
or overall performance improvement. Run/store heartbeats still share tenant
metadata locks with ordinary cross-entity transactions (#11). Capacity admission
and transitions retain a global PostgreSQL advisory lock (#13). Their local
benchmarks measure specific storage paths, not elimination of lock contention.
An independent capacity counter should be considered only after representative
load and lock-wait evidence identifies the advisory lock as a bottleneck.

## Separate real integration gaps

| Tracking task | Remaining deployment evidence | Status |
| --- | --- | --- |
| [#35 CubeSandbox](https://github.com/Garhorne0813/pi-flow/issues/35), with #14 | Non-root/readonly skills, Volume and snapshot semantics, inventory metadata, crash after create, generation-safe Kill/retry | Cube work deferred while its test environment is unavailable; Reconciler stays off by default and #14 stays open |
| [#36 enterprise MCP](https://github.com/Garhorne0813/pi-flow/issues/36) | Actual endpoint/CA/grants/delegated credentials, approval/revocation, dispatched writes with lost responses and no replay | Not production-accepted |
| [#37 model gateway](https://github.com/Garhorne0813/pi-flow/issues/37) | Trusted usage semantics, output cap, shared budgets, gateway failures, actual deltas under mixed load | Not production-accepted |

For Cube, `Sandbox.list` enumerates running instances only. Absence cannot
prove nonexistence for paused, creating or otherwise uncertain resources.
Before closing #14, demonstrate create-success/worker-crash/restart recovery;
match metadata, instance identity, operation generation and Volume; prove
successful Kill and failed-Kill retries cannot clean up a newer generation.
Unconfirmed resources stay charged; no age-based or list-absence release.
Deferring Cube work does not waive the production gate.

## Remaining production gate

Complete the separate real integration tasks and the umbrella's PostgreSQL
outage, connection exhaustion, backup/recovery and representative mixed-load
scenarios. Long sessions, 100+ concurrent Runs and 10/100/500 SSE subscribers
must be measured on the intended deployment. Define SLOs from this evidence.
Keep the following fault matrix in the signed-off release report:

| Fault | Required evidence |
| --- | --- |
| Kill worker during Cube create, after dispatch and before SID persistence | Capacity remains reserved/unknown; inventory reconciler recovers only positively owned resources; eventual cleanup is confirmed |
| Kill worker during remote tool execution | Run fails with unknown outcome; remote side effects are not retried |
| MCP disconnect after dispatch or missing response | Attempt marked unknown; approval and idempotency evidence retained; no automatic replay |
| Cube create/kill timeout and pause/resume failure | Ambiguous capacity is not freed by age; late cleanup and retry do not touch a newer generation |
| API/PostgreSQL outage or pool exhaustion during SSE | Health fails within its deadline; recovery/reconnect preserves event order and ACL checks |
| Parent cancellation, user/agent revocation and token expiry | Subagent/tool dispatch stops; stream closes; foreign tenant sees no resource |
| Rolling worker shutdown under mixed Run/SSE load | No duplicate claim; queued work resumes; unknown active work does not replay; cleanup confirmed |

Record release commit, SDK/provenance hashes, database/provider versions,
worker/API replicas, dataset, deployment resources, UTC timestamps, sanitized
request IDs, resource inventory before/after, throughput, query/write counts,
P95/P99, CPU/RSS, pool/lock waits and WAL. Never record credentials or tool text.
Verify quotas, checkpoints, reservations, tenant isolation and resource leaks.
Keep actual deployed provider results separate from synthetic and local-server
results. Store raw sanitized evidence and a signed-off pass/fail table.

#18 stays open and blocks production release until its criteria pass on the
intended deployment. Green synthetic CI permits further review and testing; it
is not production sign-off. This is the release process requirement, not an
implemented automatic check of GitHub issue state.

#19 accepts executable budget control and auditable cost estimates. Financial
provider-invoice reconciliation is independently tracked in
[#38](https://github.com/Garhorne0813/pi-flow/issues/38); usage confirmation and
observed Sandbox durations do not establish an invoice or paid charges.

## 第三轮新增的开发基线检查

新增 `worker-history.ts`（20,001 Run / 100,001 Event，索引/返回量/P95）和
`sse-history.ts`（5,000 条 Unicode 历史、满终态页、实际中途断连续传），CI 保存 JSON 报告。
它们补充早期 20 事件负载场景，仍是合成数据，不能替代 #35/#36/#37 及 #18 生产验收。
隔离 schema 的 001–004 升级/离线回滚回归见 `test/migration-roundtrip.test.ts`；
目标部署全停、备份/Volume 恢复与签署仍待完成。main protection API 返回 Forbidden，
可执行规则配置已准备，远程启用仍未完成。开发基线合并审查与生产部署门禁分开记录。
## Database connection fault stage (#18)

Run `node --import tsx scripts/acceptance/database-faults.ts` against a dedicated
 disposable PostgreSQL database. The test role must be able to terminate its
own tagged backends and briefly lock harness_schema; do not use production.
CI retains the commit-bound JSON report alongside existing load/crash reports.

This stage saturates the ten-client application pool, verifies independent HTTP
readiness/liveness and queued-read recovery, blocks a real readiness query then
checks bounded 503/recovery, and terminates tx/runTx connections before commit.
It checks rollback, one callback invocation, idle connection replacement,
LISTEN reconnection and durable event replay after losing notification transport.
Idle socket errors are observed safely; connection loss never retries a mutation.

This is connection loss/query blocking on real PostgreSQL with synthetic state.
It does not stop the server, exhaust all server connection slots, validate a
backup/Volume restoration or establish a production SLO. Those #18 gates remain
open along with actual providers and representative mixed load.
