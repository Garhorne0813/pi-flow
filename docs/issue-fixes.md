# Issue fixes and combined release candidate

The individual PRs target `work`, except the main baseline PR. The
`integration/issue-fixes` branch assembles them on the main baseline and resolves
shared Store/API/Worker/Sandbox conflicts. It is a reviewable combined candidate;
PRs #26, #23, #24 and #27 have now been merged into work. Main remains
unmerged and no deployment has been performed.

| Issue | Review PR | Scope |
| --- | --- | --- |
| #10 | [#22](https://github.com/Garhorne0813/pi-flow/pull/22) | main baseline + mandatory PostgreSQL CI; repository branch protection still requires administrator configuration |
| #11 | [#30](https://github.com/Garhorne0813/pi-flow/pull/30) | normalized runs/sessions/leases and per-Run writes; ordinary cross-entity transactions retain tenant metadata locks |
| #12 | [#31](https://github.com/Garhorne0813/pi-flow/pull/31) | batched deltas, indexed event replay and notification hints; stacked on #30 |
| #13 | [#28](https://github.com/Garhorne0813/pi-flow/pull/28) | remove global JSONB full rewrites, retain atomic quota/fencing and a global advisory lock |
| #14 | [#29](https://github.com/Garhorne0813/pi-flow/pull/29) | conservative inventory reconciliation; real Cube metadata/cleanup gate remains pending |
| #15 | [#27](https://github.com/Garhorne0813/pi-flow/pull/27) | safe structured faults, trace context, counters and executable severity rules |
| #16 | [#23](https://github.com/Garhorne0813/pi-flow/pull/23) | SSE token expiry and authorized renewed replay |
| #17 | [#24](https://github.com/Garhorne0813/pi-flow/pull/24) | bounded liveness/readiness and persistent independent Worker health |
| #18 | [#33](https://github.com/Garhorne0813/pi-flow/pull/33) | completed multiprocess/PostgreSQL/SSE synthetic stages; production release umbrella blocked on #35/#36/#37 and recovery/mixed-load gates |
| #19 | [#32](https://github.com/Garhorne0813/pi-flow/pull/32) | executable shared budgets and auditable cost estimates; invoice reconciliation separately tracked by #38 |
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

Review boundaries: #14 remains open; running-only Cube inventory absence is not
proof of nonexistence, so unconfirmed resources stay charged and Reconciler
stays off by default. Cube execution is deferred in this review. #18 remains a
production release blocker while its real integration, database recovery and
representative mixed-load gates are open. Completed synthetic/local protocol
stages retain their value without becoming production sign-off. #19 confirms
budget enforcement and estimate auditability, not provider invoices. Existing
microbenchmarks do not demonstrate elimination of tenant/advisory lock
contention or establish a production SLO.

## 第三轮合并前清单

- [x] #11：专用候选/目标读取，20,001 Run / 100,001 Event 的 idle Worker 索引、返回量和 P95 检查。
- [x] #12：SSE 满页立即追赶并让步，5,000 条历史 HTTP 中途断线回放。
- [x] 本地隔离 PG：001–004 升级、重复迁移、失败回滚、当前状态还原；目标部署演练仍待 #18。
- [x] 整合代码本地完整回归、构建/smoke；远程三项 CI 结果在 PR #34 按提交核对。
- [ ] main 分支保护：配置已准备，API GET/PUT Forbidden，尚未远程启用。
- [x] #18 保持开放且为生产发布阻塞项，#14/#35 Open、Reconciler 默认关闭。

长期 Usage/Event/Audit 增长治理另见 #39，不作为本轮已完成内容。

## Completed implementation issues (2026-10-10)

Issues #21, #16, #17 and #15 are closed as completed after merging their
PRs into work in that order. Each validated head passed the quality workflow
(TypeScript, real PostgreSQL tests, build and Demo smoke) and vendor workflow
(provenance/rebuild, SBOM and remote contract regressions). #26 adds quality CI
to work; #27 resolves the API/Worker overlaps while preserving health reporting,
telemetry, maintenance status and SSE token expiry cleanup.

Issue bodies record exact validated heads, merge commits and CI links. These
closures do not complete #10 or #18: main release, branch protection and real
production-service acceptance remain pending. Alert notification routing remains
a deployment configuration task.
