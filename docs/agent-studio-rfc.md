# RFC: isolated Agent Studio drafts and test runs

Status: proposed design, no draft execution API enabled. Tracks [#52 Phase 2](https://github.com/Garhorne0813/pi-flow/issues/52). This RFC is the prerequisite for the test workbench and its backend; implementation and security acceptance belong in subsequent changes.

## Existing contracts

Production Runs bind to immutable published AgentVersions and snapshot their capabilities. Publishing a successor changes a logical Agent's active version; existing Sessions follow it only at the next independent root task. Continuations and delegated tasks retain their original task/version identity. Agent ACL applies to every version; Workspace membership and Tenant boundaries remain authoritative. Studio must preserve these contracts.

## Proposed isolation model

Persist an `AgentDraft` with tenant, owner, logical Agent reference (optional), source version, validated configuration, revision, timestamps and expiry. Editing uses optimistic concurrency, as tenant defaults do today. A draft contains references to deployment-approved resources, never credentials, endpoint URLs, mount sources or Tenant grants.

Testing freezes a draft revision into a **separate immutable TestVersion**. TestVersions are not production AgentVersions: they cannot become an active logical Agent version, appear in production selectors, or be accepted by normal Session/Run endpoints. Publish creates a new production AgentVersion through the existing publication path after revalidating current grants. A successful test does not exempt publication from authorization and validation.

A `StudioTest` references the frozen TestVersion, initiating actor, tenant, isolated Workspace, capability policy, budget, task identity and terminal cleanup state. Execution keeps the invariant that every Run binds to an immutable version. An explicit execution namespace and storage discriminator must distinguish TestVersion-backed Runs from production Runs; reuse of Worker code requires a fail-closed admission check before scheduling and again at lease acquisition. Production Workers must reject the Studio namespace. Separate Studio worker queues, runtime identities, storage access and service credentials are required; a client-supplied `test: true` flag is insufficient isolation.

The Studio Workspace has new isolated volumes and sandbox instances. It must never attach an existing production Workspace, Session, volume, snapshot or sandbox. Fixtures enter only through an explicit authenticated copy/import operation with a size limit, provenance and audit event; importing does not grant the test access to the source Workspace. Cleanup releases sandbox leases and temporary volumes, respecting conservative accounting when remote deletion is unconfirmed. Published versions are outside the test retention lifecycle.

## Authorization and side effects

Require administrator role plus explicit Studio permission and membership of the selected Studio Workspace. Derive Tenant and actor from authentication, not request bodies. Recheck revoked membership, Agent access, resource grants and worker admission for every test admission and tool operation. A former member cannot read historical test events or resume a waiting approval.

Effective tools are the intersection of draft selection, Tenant grants, Studio policy and actor/Workspace permissions. Subagents must be explicitly approved immutable test versions or isolated copies of approved published versions. They inherit the namespace, Workspace, reduced identity, remaining budget and capability intersection; they cannot create production Sessions or fall back to production workers. Disable delegation until this admission path exists.

Default policy permits model calls and bounded reads of test fixtures. Local writes affect only isolated volumes. Bash, network access, MCP and other remote operations remain denied unless the Studio deployment explicitly grants a test-specific endpoint/credential and tool allowlist. A read-only UI label cannot make an arbitrary MCP tool read-only. Production credentials must not be available to the Studio identity. Enabling remote writes requires an explicit side-effect disclosure and existing approval mechanism, and is audited; approvals never expand deployment grants.

Provider/model choices, mounts, endpoints, credential selectors and egress policy are server-managed. Limit steps, tokens, elapsed time, concurrent tests, subagent count and depth using the minimum of configured test limits and deployment limits. Reserve capacity and budget atomically before dispatch, aggregate usage across the task chain, and prevent retries from resetting budgets. Redact secrets from events; do not put prompts or tool payloads in the administration audit stream.

## Lifecycle and API proposal

These routes are proposals, not currently implemented:

| Operation         | Proposed contract                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Create/edit draft | `/admin/studio/drafts`; edits require an expected revision; conflict is 409                                                               |
| Validate draft    | Validate schema, model grants, Skill bundle/digest, MCP allowlists, subagent admission and budget without executing tools                 |
| Start test        | Freeze an expected draft revision; require isolated Workspace and an idempotency key; reserve budget and enqueue only on the Studio queue |
| Read test/events  | Test metadata and a resumable SSE event stream, gated by Tenant and Studio Workspace ACL                                                  |
| Cancel test       | Cancel the entire task chain, including waiting interactions and descendants; idempotent                                                  |
| Publish draft     | Revalidate expected draft revision and current grants, then use existing immutable production publication semantics                       |

States: `VALIDATING → QUEUED → RUNNING ↔ WAITING_INPUT → COMPLETED / FAILED / CANCELLED / TIMED_OUT`. Admission failure creates no runnable job. Each transition records actor, draft/test version, Workspace, task ID and a sanitized failure category. Cancellation during model/tool dispatch, expired approvals and timeouts converge to a terminal state, with cleanup tracked separately. Expired drafts cannot start new tests; retained TestVersions remain readable only for their retention period and only under current ACL.

The workbench first selects an isolated Workspace and displays permitted side effects and budget. It then shows model output, tool discovery/calls, approval state, elapsed time and aggregate usage. Failures distinguish validation, authorization, capacity, provider, tool, timeout and cleanup outcomes. A comparison view displays source version versus frozen draft; publication records include the source/test references without migrating Sessions.

## Acceptance gates and delivery slices

1. Storage/admission: concurrent draft writes, immutable TestVersions, idempotent start, namespace isolation, Tenant/Workspace revocation, and rejection of test versions by all production endpoints.
2. Execution isolation: separate workers/credentials/volumes, deny production mounts/endpoints, test policy enforcement for every tool, recursive subagent constraints, aggregate budgets, cancellation during remote operations and conservative cleanup accounting.
3. Workbench: keyboard/narrow-screen workflow; bounded and redacted event history; reconnect/replay; expired authorization; successful execution with failed refresh; failed/cancelled/timed-out tests.
4. Publication/operations: revalidation after grant revocation, immutable publication audit, task/session binding regression, ACL-filtered version usage and failure/usage views.

Require automated negative tests with two tenants, a revoked Workspace member, a revoked Agent user, a malicious test version passed to a production endpoint, and a Studio identity attempting production storage/remote writes. Do not expose Start Test until gates 1 and 2 pass.

Open decisions before implementation: the exact Run namespace/storage representation and migrations; retention and cleanup reconciliation ownership; test-specific MCP credentials supported by deployment; resource limits and cost accounting; audit retention. Release approval, canary rollout and explicit Session migration/rollback policy are separate proposals.

## UCS OIDC login plan (Phase 1 follow-up)

Manual memory-only Bearer tokens remain for integration. Production login should use a same-origin backend session backed by UCS OIDC Authorization Code + PKCE. Require state/nonce, fixed redirect allowlists, issuer/audience/signature/expiry validation, and server-derived Tenant plus `harness-admin` role. Keep access/refresh tokens server-side; issue Secure, HttpOnly, SameSite cookies, enforce CSRF protection on writes, and bound session lifetime. Login errors, refresh rotation failure, logout and role revocation clear the client connection and abort outstanding requests. Cross-tab logout requires session invalidation and a non-secret notification. Never persist JWTs in browser storage or URLs.

This requires an explicit cookie-auth/CSRF integration for the API (the current console deliberately uses `credentials: "omit"`); adding an OIDC button alone would not implement authentication. Define UCS endpoints, claims, session store, refresh/logout contracts and deployment callback configuration in a separate increment, with tests for login/renewal/logout, CSRF, tenant switching and stale responses.
