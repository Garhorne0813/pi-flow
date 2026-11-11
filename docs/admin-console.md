# React management center

The embedded HTML console has been removed. `/admin/ui` and `/admin/agents/ui`
redirect to `/admin/agents`. Management uses the same sign-in as chat; no separate
administrator-token input is provided. The API continues to enforce admin access.

- `/admin/agents`: search/create/edit Agent configuration, ordered multiline
  AGENTS.md entries, model, tools, Skills/MCP, delegation, budgets, status and ACL.
  Review before saving; registry revision conflicts preserve the draft. Existing
  unedited configuration fields and queued execution snapshots remain intact.
- `/admin/skills`: choose/drop/upload ZIP, register deployed immutable versions,
  inspect metadata and enable/disable. Updates use a new version ID. Delete and
  remote text editing are not supported by existing APIs.
- `/admin/mcp`: register deployment-authorized endpoints, tool allowlists,
  enable/disable and discover tools without executing them.
- `/admin/delegation`: inspect relationships and open the Agent editor.
- `/admin/settings`: global model/key/tool policy and new-Agent defaults.

Build `web/` before running the API. Fastify serves `web/dist` and Docker includes
the frontend build. An unbuilt shell returns `WEB_UI_NOT_BUILT` (503).
`CHAT_WEB_DIR` selects a different artifact directory; `CHAT_UI_ENABLED=false`
disables static pages. OIDC public metadata uses VITE_OIDC_* Docker build args;
never put credentials in build arguments. External gateways need SPA fallbacks
for these routes. See [Chinese guide](admin-console.zh-CN.md) and
[chat deployment](chat-ui-porting.md) for details.
