# Issue fixes and combined release candidate

The individual PRs target `work`, except the main baseline PR. The
`integration/issue-fixes` branch assembles them on the main baseline and resolves
shared Store/API/Worker/Sandbox conflicts. It is a reviewable combined candidate;
no PR has been merged or deployment performed by this task.

| Issue | Review PR | Scope |
| --- | --- | --- |
| #10 | [#22](https://github.com/Garhorne0813/pi-flow/pull/22) | main baseline + mandatory PostgreSQL CI; repository branch protection still requires administrator configuration |
| #11 | [#30](https://github.com/Garhorne0813/pi-flow/pull/30) | normalized runs/sessions/leases, ancestor authorization and per-Run writes |
| #12 | [#31](https://github.com/Garhorne0813/pi-flow/pull/31) | batched deltas, indexed event replay and notification hints; stacked on #30 |
| #13 | [#28](https://github.com/Garhorne0813/pi-flow/pull/28) | normalized indexed capacity, guarded migration and fencing |
| #14 | [#29](https://github.com/Garhorne0813/pi-flow/pull/29) | conservative inventory reconciliation; real Cube metadata/cleanup gate remains pending |
| #15 | [#27](https://github.com/Garhorne0813/pi-flow/pull/27) | safe structured faults, trace context, counters and executable severity rules |
| #16 | [#23](https://github.com/Garhorne0813/pi-flow/pull/23) | SSE token expiry and authorized renewed replay |
| #17 | [#24](https://github.com/Garhorne0813/pi-flow/pull/24) | bounded liveness/readiness and persistent independent Worker health |
| #18 | [#33](https://github.com/Garhorne0813/pi-flow/pull/33) | actual multiprocess SIGKILL and PostgreSQL/HTTP load harness; real Cube/MCP/gateway gate remains pending |
| #19 | [#32](https://github.com/Garhorne0813/pi-flow/pull/32) | persistent model reservations, tenant/user budgets, price snapshots and observed resource reports |
| #20 | [#25](https://github.com/Garhorne0813/pi-flow/pull/25) | incremental extraction of providers, bounded waits and lease/lifecycle decisions |
| #21 | [#26](https://github.com/Garhorne0813/pi-flow/pull/26) | pinned source/archive verification, reproducible rebuilds and SBOM |

The combined candidate additionally applies migration 004 and expects schema
version 4. Readiness checks all normalized tables, CI migrates before running
its PostgreSQL suite, and the health test uses an isolated schema. Compose mounts
all four migrations for a fresh database; existing databases require the offline
migration procedure. The reconciler remains opt-in until the real-provider gate
passes. See run-migration.md, capacity-migration.md and acceptance.md.

Review the issue PRs individually, then use the combined candidate to assess
interaction and release readiness. If merging individual PRs into work instead,
keep #30 before #31 and carry the conflict resolutions and migration/readiness
updates from this candidate. Do not assume independently passing branches can be
merged without resolving their shared files.

Local verification includes TypeScript, build, smoke, full PostgreSQL-backed
regressions, vendor archive/installed dependency verification, actual Worker
SIGKILL and 10/100/500 SSE replay/reconnect tests. Synthetic runtime/events are
explicitly labeled and do not satisfy real Cube/MCP/gateway acceptance. External
notification routing, production pricing and branch protection are deployment or
repository configuration, not claims of this candidate.
