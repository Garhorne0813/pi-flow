<div align="center">
  <h1>Pi-Flow</h1>
  <p><strong>An AI agent backend for shared workspaces.</strong></p>
  <p>Persistent conversations, streaming execution, human approvals, and remote tools through REST and SSE.</p>
  <p>
    <a href="README.zh-CN.md">简体中文</a>
    · <a href="#quick-start">Quick Start</a>
    · <a href="#architecture">Architecture</a>
    · <a href="#client-integration">Client Integration</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24+" />
    <img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="Apache-2.0 License" />
  </p>
</div>

---

Pi-Flow runs agents on Pi and executes remote tools through CubeSandbox. Connect your own chat client, while administrators manage versioned agents, skills, and MCP services through the built-in console.

The current release is a **0.1 backend integration baseline**. Demo uses a simulated model so you can try the API without external services; real models and remote execution require the corresponding services. Enterprise production acceptance is still pending.

## Highlights

| Area | What Pi-Flow provides |
| --- | --- |
| Streaming conversations | Persistent sessions, message and tool events, Todos, SSE replay, idempotent submissions, and cancellation |
| Human interaction | Approval before writes, edits, shell commands, and MCP calls; questions and resumable answers |
| Shared workspaces | Owner/editor/viewer access, independent persistent volumes, and a workspace file API |
| Remote execution | CubeSandbox file and Bash tools, capacity controls, pause/resume, and idle reclamation |
| Versioned agents | Immutable configurations, logical agent activation, and pinned versions for task chains |
| Extensibility | Read-only versioned skills, allowlisted Streamable HTTP MCP tools, and subagent delegation |
| Administration and operations | UCS OIDC tenant isolation, budgets and usage, audit records, metrics, and Worker health |

## Quick start

Requires **Node.js 24+** and npm. No model key, database, or Cube cluster is needed for the in-memory demo.

```bash
git clone https://github.com/Garhorne0813/pi-flow.git
cd pi-flow
npm ci
npm run build
HARNESS_MODE=demo DEV_TOKEN=local-demo-token-2026 npm start
```

The API listens at `http://127.0.0.1:8080`. Demo mode seeds a Demo Agent and runs its Worker inside the API process. It uses a simulated model and in-memory files; restarting clears in-memory state.

Open **http://127.0.0.1:8080/admin/ui** and enter the `DEV_TOKEN` above to inspect the management console. Conversations use the API or your own chat client.

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
  -d '{"agentId":"00000000-0000-4000-8000-000000000001"}'

# 3. Replace <sessionId> with the returned id / 替换为返回的会话 id
curl -sS -X POST 'http://127.0.0.1:8080/api/v1/sessions/<sessionId>/runs' \
  -H 'Authorization: Bearer local-demo-token-2026' \
  -H 'Idempotency-Key: hello-001' -H 'Content-Type: application/json' \
  -d '{"message":"Hello harness"}'

# 4. Replace <runId> with the returned id / 替换为返回的任务 id
curl -N 'http://127.0.0.1:8080/api/v1/runs/<runId>/events' \
  -H 'Authorization: Bearer local-demo-token-2026'
```

The seeded logical agent ID above is for Demo only. In production, choose an accessible agent from `GET /api/v1/logical-agents` and use its returned `id` as `agentId`. Look for `message.delta` and `run.completed` in the SSE stream to confirm the conversation completed.

To keep demo metadata in PostgreSQL, use Docker Compose. Simulated files still remain in memory:

```bash
DEV_TOKEN=local-demo-token-2026 docker compose -f compose.demo.yml up --build
```

## Architecture

```mermaid
flowchart LR
    Client[API client / chat frontend] -->|REST / SSE| API[Fastify API]
    Console[Management console] --> API
    API <--> DB[(PostgreSQL)]
    Worker[Worker] <--> DB
    Worker --> Pi[Pi runtime]
    Pi --> Gateway[Model gateway]
    API --> Cube[CubeSandbox / workspace volumes and host skills]
    Worker --> Cube
    Worker --> MCP[Streamable HTTP MCP]
```

Production normally runs API and Worker as separate processes with the same database and capability policies. PostgreSQL persists sessions, Runs, and events; workspace files live on independent persistent volumes. Demo runs an inline Worker with a simulated model and in-memory Sandbox.

See the [architecture reference](docs/architecture.md) for components, execution flow, and security boundaries.

## Client integration

```text
Choose a logical agent → Create workspace → Create session → Submit Run → Follow SSE
                                                                            ↓
                                                                  Answer / approve
                                                                            ↓
                                                               Follow the new Run
```

All paths below use the `/api/v1` prefix and require `Authorization: Bearer <token>`.

| Action | Interface |
| --- | --- |
| Choose a logical agent | `GET /logical-agents` |
| Create a workspace | `POST /workspaces` with `{ "name": "…" }` |
| Create a session | `POST /workspaces/{id}/sessions` with `{ "agentId": "…" }` |
| Send a message | `POST /sessions/{id}/runs` with `Idempotency-Key` and `{ "message": "…" }` |
| Follow events or inspect status | `GET /runs/{id}/events`, `GET /runs/{id}` |
| Answer or approve / deny an action | `POST /interactions/{id}/response` with `{ "response": "…" }` |
| Cancel a task chain | `POST /runs/{id}/cancel` |

A Session follows a stable logical agent. New independent tasks use its active version; accepted tasks and approval continuations retain their pinned version. One active Run is allowed per session. `GET /agents` and the `{agentVersionId}` session selector remain compatibility interfaces; do not send both selectors.

Approval or an answer returns a **new Run ID**. Subscribe to that Run to follow the continuation. Disconnecting SSE leaves the task running; replay missed events using `Last-Event-ID`, or explicitly cancel the task chain.

Browser clients should use `fetch` streaming or an SSE client that supports authorization headers. Native `EventSource` cannot set this header. After token expiry, reconnect with a fresh token and the last event ID.

See the [API reference](docs/api.md) for workspace sharing, history and Todos, files, sandbox management, usage, complete payloads, and event types.

## Management console

The Agent editor groups logical versions, separates configuration into keyboard-navigable panels, and shows a summary and diff before publication. Unsaved drafts are protected when navigating or changing connections. See the [delivery plan](docs/agent-console-roadmap.md) and [Studio isolation RFC](docs/agent-studio-rfc.md) for subsequent increments.

Skills supports uploading a single-Skill ZIP into shared hostPath storage, automatically registering an immutable version. The API needs write access to the configured upload namespace; see [deployment](docs/deployment.md#skill-zip-uploads--技能-zip-上传).

After starting the API, open **http://127.0.0.1:8080/admin/ui** (`/admin/agents/ui` remains supported). Demo accepts `DEV_TOKEN`; production uses a UCS JWT with the `harness-admin` role. No separate frontend build is needed.

Manage agent versions and access, skills, MCP servers, and subagent delegation. Inspect deployment capabilities and save tenant defaults for new agent drafts. Deployment credentials, volumes, endpoints, and capability grants are configured server-side.

See the [management console guide](docs/admin-console.md) for operations, token handling, and configuration conflict rules.

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

API and Workers must share the database and capability policies. After startup, publish an agent through the admin API before creating a session. Deployment requirements, skill host directories (default) or volumes, credentials, and live-model checks are covered in [Deployment](docs/deployment.md).

## Current status and limits

- The management console is included; bring your own chat frontend. Long-term memory and session branching APIs are not provided.
- File APIs require a session and support UTF-8 files up to **256 KiB**, without binary file support.
- Subagents intersect parent/child permissions, share task budgets, and support cascading cancellation. Child tasks currently execute sequentially and cannot wait for user interaction.
- MCP uses deployment service credentials; delegated user OAuth is pending.
- Budgets and reports account for tokens and estimate costs rather than reconcile provider invoices.
- Instance snapshot restore retains current workspace files and history, and does not replace volume or database backups. Cube currently rejects cross-workspace snapshot clones.

See [acceptance requirements](docs/acceptance.md) for production gates and validation evidence.

## Development

```bash
npm run check
npm test
npm run build
npm run smoke
```

The smoke check starts and stops its own demo on port `18081`, covering a conversation, SSE, idempotency, and file upload/download. Some tests require `openssl`, Python 3, and Bash. PostgreSQL checks use `TEST_DATABASE_URL`; see [CI checks](docs/ci.md).

Native form-validation regression tests run when Chromium is installed at `/usr/bin/chromium` or `/usr/bin/chromium-browser`, or when `CHROMIUM_PATH` is set. They use the development-only `playwright-core` dependency and do not download a browser; without Chromium, only the native-browser test is skipped.

## Documentation

| Guide | Contents |
| --- | --- |
| [API reference](docs/api.md) | REST requests, SSE events, agent configuration, and errors |
| [Architecture](docs/architecture.md) · [架构（中文）](docs/architecture.zh-CN.md) | Components, data model, execution, and security boundaries |
| [Deployment](docs/deployment.md) | Production configuration, upgrade requirements, and live checks |
| [Usage and budgets](docs/usage-budgets.md) | Token accounting, budget policy, and cost estimates |
| [Health](docs/health.md) · [Observability](docs/observability.md) | Probes, Worker monitoring, metrics, and tracing |
| [Implementation](docs/implementation.md) · [Acceptance](docs/acceptance.md) | Implementation notes, evidence, and outstanding production gates |
| [Integration notes](docs/local-deployment.md) | Real-service deployment findings |
| [Management console](docs/admin-console.md) · [管理控制台](docs/admin-console.zh-CN.md) | Version publication, access, skills, MCP, and configuration defaults |

## Contributing

Issues and pull requests are welcome. Run relevant tests plus `npm run check` and `npm run build` before submitting changes; runtime behavior changes should include regression coverage. See [CI checks](docs/ci.md) for the validation workflow.

## License

[Apache-2.0](LICENSE). Vendored SDK provenance and licenses are documented in [vendor/README.md](vendor/README.md).
