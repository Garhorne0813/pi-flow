# Pi-Flow Chat implementation

Baseline: main `8bf3523836f3565a9d15605472c7dec57d5a410c`.
Design: supplied Pi-Flow Web Chat RFC v1.0 (2026-11-11).

## Architecture and scope

Independent React 19/Vite application in `web/`. React Router supplies browser
navigation; TanStack Query caches REST data; the local reducer owns per-Run SSE
cursors and assistant segments. No PiRuntime, Cordis, ZCode RPC or session
controller is bundled. UI primitives are original React components and the MIT
react-markdown renderer. See `web/third-party/README.md` for provenance.

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
fallback for `/chat*`, `/workspace`, `/settings`, `/admin/settings`, `/auth/callback`. Keep `/admin/ui`
on the existing backend. Proxy `/api/v1` to Fastify over the same HTTPS origin;
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
read model. Source primitives were not copied from upstream; the isolated native
renderer is the first import-closure spike.

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
Deployment details are read-only. `/admin/ui` remains available independently.
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
