# Agent console delivery plan (#52)

[#52](https://github.com/Garhorne0813/pi-flow/issues/52) is an incremental roadmap. Phase 0 shipped in #51 and was integrated with logical Agent versions/ACL in #53. This increment implements the Phase 1 editor workflow and records the prerequisite Phase 2 isolation RFC. It does not enable draft execution.

## Phase 1 editor increment

- Group published versions by logical Agent identity, including renamed historical versions; independent same-name Agents stay separate. Show full version ID, timestamp, active/history/disabled state.
- Use a two-column layout and five keyboard-navigable editor panels: basic information/Prompt, model, tools/Skills/MCP, subagents, budget/access explanation. Narrow screens stack the panels.
- Review configuration summary and changed fields before a separate explicit publication. Show unavailable resources/model/Bundle/delegation warnings and actual Agent ACL/Session semantics. The API remains authoritative.
- Preserve Agent/defaults and access drafts on unrelated refreshes. Confirm authorization expansion to newly specified users as well as all-tenant access. Confirm destructive draft navigation, reconnect/disconnect and page exit. Invalidate review after edits, disable concurrent submissions and focus the first invalid field even in a hidden panel.
- Compose the public HTML shell from API client, editor, registries, settings, controls, styles and connection-controller source fragments. No frontend runtime dependency/build pipeline is added; the server retains per-response script nonce, no-store and memory-only tokens.
- On API 401, clear the connection and abort outstanding requests. Other API failures retain editable drafts; write success remains successful when its refresh fails. Stale responses never replace a newer connection.

Regression acceptance includes Markdown entry round-trips, restricted/all-tenant authorization, revision conflicts, 400/401/403/409/5xx, failed post-write refresh, connection replacement, keyboard tabs, mobile/tablet layout, native validation, grouped versions and the full clone/review/publish flow. Existing backend tests cover immutable versions, lazy Session upgrades and Tenant/Workspace ACL.

## Subsequent executable increments

### UCS login integration

Implement the [OIDC plan](agent-studio-rfc.md#ucs-oidc-login-plan-phase-1-follow-up) after specifying deployment endpoints and session/CSRF contracts. Acceptance: login/logout/renewal, role revocation, Tenant switching, no browser-stored JWT, CSRF and delayed-response regression. Manual token login remains the integration path until then.

### Studio storage and execution admission

Implement draft revisions, isolated TestVersions, Workspace admission and worker namespaces from the [RFC](agent-studio-rfc.md). Acceptance: negative Tenant/Workspace/production-endpoint tests and deployment isolation, atomic budgets, cancellation and audited cleanup. No arbitrary unpublished execution through production Workers.

### Studio workbench and operations

After isolation acceptance, add test input, model/tool/MCP/approval timelines, usage and timeout/cancellation display, and authorized version-use/Run observations. Acceptance: current ACL on every read/event, replay after reconnect, bounded payloads and failure categories. Publication uses existing immutable AgentVersions; Session migration, canary and release approval remain separate projects.
