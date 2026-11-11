# Pi-Flow Chat implementation

Baseline: main `8bf3523836f3565a9d15605472c7dec57d5a410c`.
Design: supplied Pi-Flow Web Chat RFC v1.0 (2026-11-11).

## Architecture and scope

Independent React 19/Vite application in `web/`. React Router supplies browser
navigation; TanStack Query caches REST data; the local reducer owns per-Run SSE
cursors and assistant segments. No PiRuntime, Cordis, ZCode RPC or session
controller is bundled. The presentation layer now directly vendors MIT-licensed DeepSeek Harness theme tokens,
controls and surface styles, with Pi-Flow adapters and the react-markdown renderer. See `web/third-party/README.md` for provenance.

Implemented: Agent selection, session creation/list pagination/rename/delete,
text submission, streaming Markdown/code copy, IME-safe input, session drafts,
stop, tool status, question/approval cards, continuation discovery, read-only
workspace text/ls, light/dark theme, mobile navigation, explicit load-older,
scroll-to-latest and scroll anchoring. Same-session sends use a Web Lock and
Idempotency-Key; uncertain submission retries reuse the key while the tab lives.

The additive read APIs are registered only for PersonalService:
- `GET /api/v1/sessions/:id/timeline?limit=50&cursor=...`: chronological items
  within newest-first pages, stable `(timestamp, source ID)` cursor. Only root
  human prompts become user items; child/continuation/scheduled prompts are
  excluded. No raw entries, private configuration, tool arguments/results or
  tokens are returned. Streaming deltas remain on the existing SSE transport.
- `GET /api/v1/sessions/:id/active-task`: current root/continuation Run summary.

PostgreSQL reads use user/session predicates and soft-delete validation, with
additive indexes in migration 016. MemoryStore has a demo-only projection
fallback. Execution schema version stays 13: this migration only adds indexes,
not tables or mandatory runtime columns. Existing readiness stays compatible.

## Development

```sh
npm ci
npm run build
# Start the existing backend per README (DemoRuntime or real PersonalService).
cd web
npm ci
CHAT_API_TARGET=http://127.0.0.1:3000 npm run dev
```

For isolated DemoRuntime testing, set `CHAT_DEV_TOKEN` in the Vite server process
to the backend's development credential. This is a server-side proxy header;
never use `VITE_*` for secrets or expose that proxy to untrusted users.

Production requires an OIDC public client with PKCE S256, exact
`https://<site>/auth/callback` redirect, browser-accessible discovery/token
endpoints, allowed origins, and the Pi-Flow API audience. Configure
`VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, and `VITE_OIDC_SCOPE` before building.
Access tokens stay in memory; only authorization transaction state (PKCE verifier)
is in sessionStorage. Reload/expiry requires login again and restores the chat
route. Do not infer public-client support from backend JWKS configuration. A
server-side BFF remains the recommended alternative where UCS disallows PKCE
public clients; it is not implemented in this change.

## Deployment

Build with `cd web && npm run build`. Serve `web/dist` at the site root with SPA
fallback for `/chat*`, `/workspace`, `/settings`, `/admin/settings`, `/auth/callback`. Serve `/admin/*` management SPA routes from the same frontend; legacy `/admin/ui` and `/admin/agents/ui` redirect to `/admin/agents`. Proxy `/api/v1` to Fastify over the same HTTPS origin;
disable buffering and response aggregation for Run SSE. Set HTML no-cache,
immutable caching for hashed assets, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and a CSP appropriate for the configured OIDC
issuer (`default-src 'self'; script-src 'self'; style-src 'self'; object-src
'none'; base-uri 'self'; frame-ancestors 'none'`, with issuer on connect-src).
Use a gateway route switch for rollout; rollback static assets independently.

## Validation and remaining RFC gates

Commands: root `npm run check`, `npm run build`, `npm test`; web `npm test`,
`npm run build`, `npm audit --audit-level=high`;
`node scripts/check-chat-dependencies.mjs`;
`TEST_DATABASE_URL=... npx tsx --test test/chat-postgres.test.ts`;
`node web/e2e/chat-flow.mjs` against the running Vite and DemoRuntime servers.

This implementation is an initial reviewable chat slice, not a production
readiness declaration for the full RFC. Remaining gates: registered UCS client
or BFF integration and real non-admin login/revocation; Cube/Aliyun live tests;
legacy entries/fork inherited-history backfill; scheduled-origin presentation;
full subagent/Todo/usage views, virtualized large histories, command completion,
message search; richer server-redacted tool summaries; durable uncertain-send
recovery across reload; full fault-injection and Firefox/Safari accessibility
matrix. Fork UI is deliberately deferred until inherited history has a supported
read model. The initial native renderer spike is superseded by the documented DSH presentation port.

Observed local results (2026-11-11): backend regression 334 passed / 0 failed /
63 PostgreSQL-gated skips before provisioning a database; dedicated real-PG chat
integration passed (keyset, isolation, active task, soft delete); browser chat
acceptance passed against both MemoryStore and PostgreSQL DemoRuntime. Browser
interaction fixture passed for approval, question, continuation and unsafe HTML /
URL rejection. Web unit tests: 5 passed. Frontend production build and dependency
audit passed (0 advisories). Real OIDC and real sandbox providers were not tested.

## Role-specific settings

`GET /api/v1/me` returns only the authenticated personal user ID, server-derived
admin/user role, and optional credential expiry (`Cache-Control: no-store`).
The browser does not infer privileges from JWT decoding or local preferences.
It refreshes identity every 15 seconds and on focus. Administrative data is
requested only after the identity check succeeds; `/admin/settings` denies a
non-admin direct navigation. Existing API admin authorization remains the
security boundary for every read and write.

`/admin/settings` edits the existing global model catalog (write-only secret
rotation), global disabled-tool policy, and new-Agent defaults. Writes retain the
server revision check; a conflict preserves edits and offers explicit reload.
Deployment details are read-only. The old embedded console has been removed; `/admin/ui` redirects to the React Agent manager.
There is no new role assignment capability in this change.

`/settings` displays the current identity and saves theme, send shortcut and new
chat default Agent in browser localStorage under a user-scoped key. These are
browser-local preferences, not cloud-synchronized user profile data. Invalid
stored preferences fall back to safe defaults. Model keys and Bearer tokens are
never persisted with these preferences. System theme changes apply immediately;
IME composition and Shift+Enter cannot trigger a send with either shortcut.

Role/settings validation: backend role authorization and revision-conflict test
passes; browser acceptance covers hidden admin navigation, direct route denial,
admin model/secret and defaults submission, conflict edit preservation, and
persisted ordinary-user preferences. The role test is part of chat-web CI.

Chat drafts now also include the current user ID in the browser storage key;
an unsent new-chat draft is not reused when a different user logs in to the
same tab. Sending is disabled until the backend identity has been confirmed.


## Embedded console migration

All embedded-console source in `src/admin-ui/` is removed. React management
covers Agent editing/creation and ACL/status, Skill ZIP/drop/upload/registration
and status, MCP registration/status/discovery, delegation and global/default
settings. Agent registry writes use the current revision and preserve unedited
config fields. Personal-platform semantics apply; shared-engine versioned APIs
remain available as APIs but are not a second UI. Fastify now serves the built
SPA and hashed assets; Docker builds/copies web assets. Root quality CI builds
the frontend before real-backend Chromium management acceptance.

The obsolete embedded-controller/DOM tests retire with that implementation.
Replacement coverage includes old URL redirects and API authorization plus real
React + Fastify Agent edits preserving extra fields and queued snapshots, Skill
ZIP publication, revision/ACL/API tests and the existing React role/settings
browser matrix. Skills still have immutable versions; delete/edit-in-place
operations are not invented by the new UI.

Migration verification: 377 backend tests passed with PostgreSQL enabled (zero
failures/skips), including real Fastify + Chromium Agent creation/editing,
preserved extra configuration/AGENTS.md entries/queued snapshots, Skill ZIP
upload and status, MCP registration/check failure feedback, legacy redirects,
and static artifact/rollout-switch checks. Web tests and production build pass;
ordinary-user direct navigation to each admin route is blocked without admin
requests. Further real Docker image/container verification is omitted per the
user's instruction; the image packaging change is not claimed as locally verified.

The default quality workflow no longer runs the real Docker Compose smoke test,
per the user request. The standalone script is retained for operator use but is
not executed by this implementation or the default CI pipeline.


## DeepSeek Harness presentation port

Directly copied from upstream `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`:
light/dark design tokens, typography/elevation/scrollbar/syntax palettes,
Button/Pill/UserMessageBubble React components, and the sidebar, hero, composer,
Markdown and code-card CSS modules. Source copies remain byte-identical;
`web/third-party/dsh/provenance.json` records paths and SHA-256 values. The
license is retained and aggregated with runtime dependency licenses in the
built `third-party-notices.txt`. CI verifies provenance and license aggregation.
No upstream logo, wordmark, font or brand illustration is copied.

Pi-Flow host markup uses the imported modules for its centered empty-state
composer, neutral sidebar, blue send control, user bubbles and code cards.
Markdown/GFM and code highlighting are lazy loaded. Highlighter output escapes
source before rendering; raw Markdown HTML/images remain disabled and dangerous
links remain rejected. Safe-source tests cover script/image/iframe injection.
All Pi-Flow API clients, reducers, role guards, approvals and admin actions stay
local; no DSH state model or runtime package is introduced.

`node web/e2e/presentation.mjs` captures desktop, dark, mobile, conversation and
admin previews under `work/previews/`; conversation screenshots use synthetic
fixtures, separately from real-backend business acceptance. The same script
checks palette application, code highlighting/wrapping, GFM tables and mobile
navigation/overflow, and CI uploads the previews for review. No Docker validation.
