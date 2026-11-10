# Management console

[简体中文](admin-console.zh-CN.md) · [README](../README.md)

After starting the API, open the [Management Console](http://127.0.0.1:8080/admin/ui) (`/admin/agents/ui` remains supported) and enter an administrator Bearer token.

- **Agents**: publish immutable configurations, clone versions, select capabilities, and manage status and allowed users. Access scope is explicit: restricted mode requires at least one user, and widening access to all tenant users requires confirmation. Disable a version to deny everyone access.
- **Skills**: upload a single-Skill ZIP into shared hostPath storage and automatically register it, or register existing immutable deployment versions, inspect bundle/path/digest details, and enable or disable versions. Register a new version ID when content changes.
- **MCP Servers**: register servers against tenant-granted endpoints, select tool whitelists, manage status, and check connections. Checks discover whitelisted tools without executing them; an empty whitelist grants no tools.
- **Subagent delegation**: inspect version relationships, concurrency and depth limits; open a parent agent to clone and update its delegation configuration.
- **Global configuration**: inspect approved models, granted bundles/endpoints and sandbox policy; save tenant defaults for new agent drafts. Defaults do not alter published versions or existing sessions. Refresh loads changes from other administrators when the defaults form is unedited; unsaved edits are retained with a conflict notice and an explicit reload option. Saves require an expected revision checked atomically on the server; stale writes return 409 and preserve the draft for reload or explicitly confirmed retry.

The standalone console needs no frontend build. Its HTML shell is public, but management APIs require administrator authorization. Tokens remain in page memory, never browser storage or URLs; disconnect aborts pending requests and clears page data. Production uses a UCS JWT with the `harness-admin` role; Demo accepts `DEV_TOKEN`.

Deployment settings (credentials, skill volumes, MCP endpoints, tenant grants and sandbox policy) are read-only in the console; configure them server-side and restart the relevant API/Worker processes. The console never returns credentials or endpoint URLs. For manual Skill registration, deploy files first; ZIP uploads install files automatically. Configure MCP endpoints before registration. Tenant draft defaults persist in the production database; Demo stores them in memory and resets them on restart. This is an administration console, not a chat client.

See the [API reference](api.md#管理控制台) for management endpoints and payloads.

### Upload a Skill ZIP

Open Skills, enter a version ID (for example `review@v1`), name, optional description and granted Bundle, drag one ZIP into the upload area or use the file picker, then click Upload and register. Include one `SKILL.md` at the root or in a single top-level Skill directory, with any scripts/references. No host path or SHA-256 input is needed. The new version is immediately selectable in an Agent configuration.

Limits: 10 MiB archive, 32 MiB expanded, 1000 files. Multiple/non-ZIP/oversized drops retain the previous selection; dropping is disabled while uploading or disconnected. Failures preserve the form/file selection; success clears the upload form. A successful upload followed by a failed refresh is still reported as successful. Existing IDs cannot be overwritten: use a new version ID for changes. The API needs write access to the shared root's `uploads/` namespace; see [deployment](deployment.md#skill-zip-uploads--技能-zip-上传). When uploading is disabled, expand Register existing deployment version to use manual registration.
