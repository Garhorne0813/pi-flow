# PR #63–#68 review follow-up

Reviewed the stacked evaluation implementation through PR #68 (`a299a46`), including the fixes already present in later layers. Fixes are applied together on the final stack branch so the accepted deployment contains consistent API, worker and grading behavior.

| Priority | Layer | Reproduced problem | Resolution |
| --- | --- | --- | --- |
| P1 | #63 / #65 | Tool graders compare displayed arguments after redaction/truncation. Correct sensitive or long arguments fail; a denied call has no displayed arguments, so an argument-qualified `tool_not_called` can incorrectly pass. | Match the original canonical argument digest, preserving redacted traces and supporting legacy traces without a digest. Cover called/not-called and all trajectory modes. |
| P1 | #66 | A job's hold is charged at creation, but requests can execute on another day/month without checking that period's normal Run/Eval spending. | Recheck current shared caps under the existing user lock, accounting for the reduced hold exactly once. Cover daily and monthly rollover, rollback on rejection, and same-period transfers. |
| P2 | #66 / #67 | Per-case target and Judge token accounting is combined, so target usage can exhaust the Judge model's independent allowance. | Filter per-case usage by request role; retain the common job hold and shared user caps. Cover successful independent reservations and exhaustion in each role. |
| P2 | #68 | Schema safety traversal treats property names and literal data as keywords. A valid schema with fields named `format` or `pattern` returns a grader error. | Traverse schema positions only, preserving nested regex/remote-reference restrictions. |
| P2 | #68 | Studio new/page actions leave the previous draft or published-version selection active. Publishing after changing the suite page can publish the previous suite. Late suite loads can also restore an obsolete selection. | Clear draft/version state, reload after paging, fence obsolete responses, and disable dependent actions while loading. Cover new/paging/publish behavior in Chromium. |

The grading fixes use native grader version 2. New snapshots record it; workers reject unavailable frozen versions before model execution, and comparison gates reject differing versions. Old completed reports remain readable. Queued version-1 jobs must be recreated after upgrading.

PR #64's optimistic revisions, immutable publication, tenant boundaries and preserved history were also reviewed and exercised through the existing PostgreSQL tests; no additional confirmed defect was found there. The previously suspected Judge budget-error categorization is already fixed in #68 and remains covered by its existing test.

Regression cases for the five findings fail before the corresponding fixes. Validation uses a disposable local PostgreSQL 17 instance and Chromium; no real model credentials or production data are used. Deployment feature flags remain off by default.

Validation completed: TypeScript check and build passed; the full suite passed **426 tests, 0 failures, 0 skips**, with PostgreSQL and Chromium. Demo smoke and the dedicated-process Eval HTTP/SSE smoke both passed, including idempotency, cancellation, reports, comparison and zero production records. The SDK test configuration directory was placed under `work/`, and the disposable database was migrated before the final full run. Real-provider and Compose acceptance were not rerun for this follow-up.

## Follow-up on submitted reviews

All twelve findings in the subsequently submitted reviews were checked against `e269241` and addressed on the final stack branch. PRs #63 and #65 had no submitted findings. The table links each finding to its resolution; it does not mark earlier stack branches or their review threads as updated.

| Review | Resolution |
| --- | --- |
| [#64: deleted Suite history](https://github.com/Garhorne0813/pi-flow/pull/64#discussion_r4545407526) | Memory and PostgreSQL stores allow the owner to enumerate and paginate archived versions while management still hides the deleted Suite. Missing/cross-user IDs remain 404. |
| [#66: idempotent cancellation view](https://github.com/Garhorne0813/pi-flow/pull/66#discussion_r4545407348) | A repeated POST projects live `state` and `cancel_requested` columns exactly like GET, including during active cancellation and after termination. |
| [#67: Judge failures overridden by aggregation](https://github.com/Garhorne0813/pi-flow/pull/67#discussion_r4545398151) | A failed positive-weight Judge vetoes a case pass even if the weighted quality mean exceeds the case threshold. Continuous scores remain intact; zero-weight observations do not veto unless explicitly hard. Native grader version 3 freezes the changed semantics. |
| [#68: new Suite copies old cases](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405001) | Every new-draft path resets cases to the initial example instead of retaining the previous dataset. |
| [#68: stale Job detail race](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405008) | Detail requests are keyed by account, Job and case page. A changed selection starts a fresh request immediately; report and cases render together only after both remain current. |
| [#68: comparison across Job pages](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405013) | Baseline/candidate inputs preserve selected IDs across list pages and accept known historical Job IDs, with page suggestions. |
| [#68: Agent pagination](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405018) | Explicit bounded Agent pages expose authorized Agents beyond the first 50 entries. |
| [#68: published-version pagination](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405024) | Version pages expose versions older than the newest 100 for viewing and starting jobs. |
| [#68: polling recovery](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405026) | Transient errors retain automatic retries; only 401/403 stop polling. A successful manual refresh resumes it, and successful recovery clears the transient-error status. |
| [#68: inactive case weights](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405033) | Suite quality rates and means use frozen case weights, with explicit weighted denominators and unweighted metrics. Zero-weight observations do not affect gates; all-zero comparisons return a null gate. Raw evidence, errors and costs remain visible. |
| [#68: incomplete repeat statistics](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405036) | Every repeat group includes requested/scored/ungraded counts, errors, cancellations and pending outcomes, including all-error groups. Variance stays null until all requested repeats are scored. |
| [#68: pagination before authorization](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545405041) | Job list pagination counts authorized rows, scanning bounded history batches until the requested page fills or history ends. Unexpected authorization/storage errors propagate instead of becoming hidden rows. |

Added regressions cover Judge score/threshold disagreement, cancellation-in-progress replay, archived-history tenant boundaries, more than a full revoked page, unequal/zero case weights, incomplete/all-error repeats, delayed old browser responses, Agent/version pagination, cross-page comparison IDs, new-draft isolation and polling recovery.

Final validation for this follow-up: **434 tests passed, 0 failures, 0 skips**, using PostgreSQL 17, Chromium and test concurrency 2. TypeScript check/build, Demo smoke and the separate-process Eval HTTP/SSE smoke passed. The test fixtures for short-lived SSE credentials now start their lifetime at authentication and allow the Eval stream's initial database reads to complete under concurrent load; expiration, cross-user denial and renewal/replay assertions remain covered. No production authorization expiry behavior changed.

## Second submitted-review follow-up

Seven new findings were submitted against `7d89b66`; the preceding twelve were confirmed fixed by that review. All seven are addressed on the final stack branch:

| Review | Resolution and regression |
| --- | --- |
| [#65: revoked frozen gateways](https://github.com/Garhorne0813/pi-flow/pull/65#discussion_r4545652208) | Target and Judge execution must match the currently approved gateway ref before secret resolution and model reservation. Old immutable versions remain stored, but cannot grant execution authority. Historical reports retain their read ACL. Tests rotate both refs and reject further budget tickets without adding charges. |
| [#67: unnecessary global Judge dependency](https://github.com/Garhorne0813/pi-flow/pull/67#discussion_r4545653726) | Published cases are read before snapshot creation; only Suites with Judge graders freeze/authorize a Judge. Native-only jobs execute with a broken global Judge selection and retain zero Judge cost holds for free target models. Required-but-missing Judge configuration still fails. |
| [#68: cross-account late responses](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545645181) | API responses/errors carry an account-generation fence, lists also check their page/generation before rendering, and reconnect clears old selections. Chromium tests hold A's Suite/Job response, connect B, then release A and verify B's UI remains isolated. |
| [#68: unbounded authorization history loop](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545645186) | A live ACL scope feeds one filtered SQL query with an Agent history index. A 100,000-revoked-job test verifies one indexed page query, no per-job authorization and no history query when all Agents are revoked. Readiness requires the new additive index. |
| [#68: target model request cap](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545645191) | Studio exposes and validates 1..100 target calls, defaulting to 100. API defaults remain compatible. Tests verify request propagation, rejection of invalid values and successful reservation of request 31 with rejection of request 32 at the chosen limit. |
| [#68: duplicate Start operations](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545645200) | Per-account in-flight guards disable/coalesce Start; an unchanged failed operation reuses its idempotency key. Browser coverage double-clicks a blocked POST, retries a simulated ambiguous failure with the same key, and verifies a later completed intent uses a new key. |
| [#68: invalid baseline passing gates](https://github.com/Garhorne0813/pi-flow/pull/68#discussion_r4545665996) | Cancelled/failed or ungraded positive-weight baselines return `BASELINE_NOT_GRADED`, incomparable/null gates and no false improvement. Fully graded assertion failures remain valid baselines. |

Validation: **443 tests passed, 0 failures, 0 skips**, with PostgreSQL 17, Chromium and test concurrency 2. The 100,000-job fixture verifies use of the Agent-history index and a single SQL page query without per-job authorization. TypeScript check/build, dedicated-process Eval HTTP/SSE smoke and Demo smoke passed. The Demo startup check was rerun separately after concurrent process startup exceeded its short readiness window. Deployment must rerun the idempotent migrations to add the required `personal_eval_jobs_agent_history` index; the personal schema version remains 14.
