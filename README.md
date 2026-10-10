# Pi-Flow

**An agent backend for shared workspaces, streamed conversations, and controlled tool execution.**

Pi-Flow lets you build agent applications around persistent workspaces and conversations. Users submit tasks, follow live responses, approve tool actions, and access workspace files through REST and SSE. Administrators publish versioned agents and control their models, skills, and MCP tools.

Built on Pi, with CubeSandbox for remote execution. The current release is a **0.1 backend**; bring your own chat UI or API client.

[简体中文](README.zh-CN.md)

## Features

### Agent conversations

- **Streaming responses** — receive message deltas, tool results, task status, and interaction requests over SSE.
- **Persistent sessions** — keep conversation history and Todo state in a workspace; each session pins an agent version.
- **Reconnect and cancel** — replay missed events using `Last-Event-ID`; disconnecting leaves the task running, while an explicit cancel stops it.
- **Reliable submissions** — an idempotency key prevents duplicate task creation; one active Run is allowed per session.

### Human interaction

- **Approval before action** — model-initiated writes, edits, shell commands, and MCP calls require approval.
- **Questions and answers** — agents can request user input and continue after a response.
- **Task lists** — agents maintain Todos that clients can display alongside the conversation.

Approval or an answer returns a **new Run ID**. Subscribe to that Run to follow the continuation.

### Workspace files and execution

- **Remote tools** — agents read, write, edit, list, search, and run Bash in CubeSandbox.
- **Workspace storage** — production workspaces use independent persistent volumes; authorized skills mount as read-only volumes.
- **File API** — list, upload, and download UTF-8 files up to 256 KiB after creating a session.
- **Sandbox controls** — inspect capacity, pause, resume, or release an instance; idle instances are reclaimed automatically. Snapshot restore retains current workspace files and conversation history. Cube currently rejects cross-workspace snapshot clones.

### Skills, MCP, and subagents

- **Versioned skills** — enable selected skills for each agent, with manifest integrity checks.
- **MCP integrations** — expose selected tools from configured Streamable HTTP servers, with tool allowlists and approval.
- **Subagent delegation** — delegate to separate child sessions with intersected permissions, shared task budgets, and cascading cancellation. Child tasks currently execute sequentially and cannot wait for user interaction.

### Access and usage controls

- **Tenant isolation** — authenticate through UCS OIDC and share workspaces with owner, editor, or viewer roles.
- **Agent administration** — publish immutable configurations, restrict access, and disable agents, skills, or MCP servers.
- **Budgets and reporting** — enforce configured token and estimated cost budgets; inspect user, Run, and tenant usage.
- **Operational visibility** — request IDs, audit records, metrics, and Worker health help trace task execution.

## User interface

Pi-Flow's interface is HTTP. A client typically follows this flow:

```text
Choose an agent → Create a workspace → Create a session → Submit a Run
                                                             ↓
                                                    Follow the SSE stream
                                                             ↓
                                              Answer / approve when requested
                                                             ↓
                                                  Follow the returned new Run
```

All paths below use the `/api/v1` prefix and require `Authorization: Bearer <token>`.

| User action | Interface |
| --- | --- |
| Choose an available agent | `GET /agents` |
| Create or browse workspaces | `POST /workspaces`, `GET /workspaces` |
| Share a workspace | `PUT /workspaces/{id}/members/{userId}` |
| Create or browse conversations | `POST /workspaces/{id}/sessions`, `GET /workspaces/{id}/sessions` |
| Read conversation history and Todos | `GET /sessions/{id}` |
| Send a message | `POST /sessions/{id}/runs` with `{ "message": "…" }` |
| Follow output or inspect task status | `GET /runs/{id}/events`, `GET /runs/{id}` |
| Cancel a task | `POST /runs/{id}/cancel` |
| Answer or approve / deny an action | `POST /interactions/{id}/response` with `{ "response": "…" }` |
| List / upload / download files | `GET /workspaces/{id}/files`, `POST /workspaces/{id}/files`, `GET /workspaces/{id}/files/{fileId}` |
| Inspect or manage an execution environment | `/workspaces/{id}/sandbox`, `/workspaces/{id}/sandbox/snapshots`, `/sandbox-capacity` |
| Inspect personal or task usage | `GET /usage`, `GET /runs/{id}/usage` |

Administrators use `/admin/agents`, `/admin/skills`, `/admin/mcp-servers`, `/admin/audit`, `/admin/stats`, and `/admin/usage`. See the [API reference](docs/api.md) for methods, payloads, event types, and errors.

For browser clients, use `fetch` streaming or an SSE client that supports authorization headers. Native `EventSource` cannot set this header. After token expiry, reconnect with a fresh token and the last event ID.

## Quick start

Requires **Node.js 24+** and npm. No model key, database, or Cube cluster is needed for the in-memory demo.

```bash
npm ci
npm run build
HARNESS_MODE=demo DEV_TOKEN=local-demo-token-2026 npm start
```

The API listens at `http://127.0.0.1:8080`. Demo mode seeds a Demo Agent and runs its Worker inside the API process. It uses a simulated model and in-memory files; restarting clears in-memory state.

In another terminal, create your first conversation:

```bash
# 1. Create a workspace / 创建工作区
curl -sS -X POST http://127.0.0.1:8080/api/v1/workspaces \
  -H 'Authorization: Bearer local-demo-token-2026' \
  -H 'Content-Type: application/json' -d '{"name":"My workspace"}'

# 2. Replace <workspaceId> with the returned id / 替换为返回的工作区 id
curl -sS -X POST 'http://127.0.0.1:8080/api/v1/workspaces/<workspaceId>/sessions' \
  -H 'Authorization: Bearer local-demo-token-2026' \
  -H 'Content-Type: application/json' \
  -d '{"agentVersionId":"00000000-0000-4000-8000-000000000001"}'

# 3. Replace <sessionId> with the returned id / 替换为返回的会话 id
curl -sS -X POST 'http://127.0.0.1:8080/api/v1/sessions/<sessionId>/runs' \
  -H 'Authorization: Bearer local-demo-token-2026' \
  -H 'Idempotency-Key: hello-001' -H 'Content-Type: application/json' \
  -d '{"message":"Hello harness"}'

# 4. Replace <runId> with the returned id / 替换为返回的任务 id
curl -N 'http://127.0.0.1:8080/api/v1/runs/<runId>/events' \
  -H 'Authorization: Bearer local-demo-token-2026'
```

The seeded agent ID above is for Demo only. In production, select an accessible published version from `GET /api/v1/agents`.

To keep demo metadata in PostgreSQL, use Docker Compose. Simulated files still remain in memory:

```bash
DEV_TOKEN=local-demo-token-2026 docker compose -f compose.demo.yml up --build
```

## Connect real services

Production requires PostgreSQL, a model gateway, CubeSandbox, and UCS OIDC or an explicitly configured isolated development identity. Copy [.env.example](.env.example), fill in your deployment settings, then run:

```bash
cp .env.example .env
npm ci
npm run build
node --env-file=.env dist/migrate.js
node --env-file=.env dist/main.js
# In a separate terminal / deployment unit:
node --env-file=.env dist/worker-main.js
```

API and Workers must share the database and capability policies. After startup, publish an agent through the admin API before creating a session. Deployment requirements, skill volumes, credentials, and live-model checks are covered in [Deployment](docs/deployment.md).

## Development

```bash
npm run check
npm test
npm run build
npm run smoke
```

The smoke check starts and stops its own demo on port `18081`, covering a conversation, SSE, idempotency, and file upload/download. Some tests require `openssl`, Python 3, and Bash. PostgreSQL checks use `TEST_DATABASE_URL`; see [CI checks](docs/ci.md).

## Documentation and status

| Guide | Contents |
| --- | --- |
| [API reference](docs/api.md) | REST requests, SSE events, agent configuration, and errors |
| [Architecture](docs/architecture.md) · [架构（中文）](docs/architecture.zh-CN.md) | Components, data model, execution, and security boundaries |
| [Deployment](docs/deployment.md) | Production configuration, upgrade requirements, and live checks |
| [Usage and budgets](docs/usage-budgets.md) | Token accounting, budget policy, and cost estimates |
| [Health](docs/health.md) · [Observability](docs/observability.md) | Probes, Worker monitoring, metrics, and tracing |
| [Implementation](docs/implementation.md) · [Acceptance](docs/acceptance.md) | Implementation notes, evidence, and outstanding production gates |
| [Integration notes](docs/local-deployment.md) | Real-service deployment findings |

This release is a runnable integration baseline; enterprise production acceptance is still pending. It has no bundled frontend, long-term memory, or session branching API. File APIs do not support binary files. MCP uses deployment service credentials; delegated user OAuth is pending. Budget reports estimate costs rather than reconcile provider invoices, and instance snapshots do not back up workspace volumes.

## License

[Apache-2.0](LICENSE). Vendored SDK provenance and licenses are documented in [vendor/README.md](vendor/README.md).
