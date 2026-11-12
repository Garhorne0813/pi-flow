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
