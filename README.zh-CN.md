# Pi-Flow

**面向共享工作区、流式对话和受控工具执行的智能体后端。**

Pi-Flow 为智能体应用提供持久化工作区和会话。用户通过 REST 与 SSE 提交任务、查看实时回复、审批工具操作并访问工作区文件；管理员发布版本化智能体，管理其模型、技能和 MCP 工具。

基于 Pi 运行智能体，使用 CubeSandbox 执行远程工具。当前为 **0.1 后端版本**，可接入自己的对话前端或 API 客户端。

[English](README.md)

## 功能特色

### 智能体对话

- **流式回复**：通过 SSE 接收消息片段、工具结果、任务状态和交互请求。
- **持久化会话**：在工作区中保存对话历史和 Todo；每个会话固定使用一个智能体版本。
- **重连与取消**：使用 `Last-Event-ID` 回放遗漏事件；断开连接不会取消任务，可显式提交取消请求。
- **可靠提交**：幂等键避免重复创建任务；同一会话只允许一个活跃 Run。

### 人机交互

- **操作审批**：模型发起写入、编辑、Shell 和 MCP 调用前，需要用户审批。
- **问答续跑**：智能体可向用户提问，收到回答后继续任务。
- **任务列表**：智能体维护 Todo，客户端可在对话旁展示进度。

提交审批或回答后，接口返回**新的 Run ID**；客户端订阅新 Run，跟进后续执行。

### 工作区文件与执行环境

- **远程工具**：智能体在 CubeSandbox 中读取、写入、编辑、列出、搜索文件及运行 Bash。
- **工作区存储**：生产模式使用独立持久卷，已授权技能以只读卷挂载。
- **文件接口**：创建会话后，可列目录、上传和下载不超过 256 KiB 的 UTF-8 文件。
- **Sandbox 管理**：查询容量，手动暂停、恢复或释放实例，自动回收空闲实例。快照恢复保留当前工作区文件与对话历史；Cube 当前拒绝跨工作区快照克隆。

### 技能、MCP 与子智能体

- **版本化技能**：为每个智能体选择技能，并校验技能清单完整性。
- **MCP 集成**：接入部署配置的 Streamable HTTP 服务，按工具白名单和审批控制调用。
- **子智能体委派**：在独立子会话中执行任务，使用父子权限交集、共享任务预算及级联取消。子任务目前顺序执行，不能等待用户交互。

### 权限与用量管理

- **租户隔离**：通过 UCS OIDC 认证，以 owner、editor、viewer 角色共享工作区。
- **智能体管理**：发布不可变配置，限制使用者，禁用智能体、技能或 MCP 服务。
- **预算与报表**：执行配置的 Token 与估算费用预算，查询用户、Run 和租户用量。
- **运行可观测性**：通过请求 ID、审计、指标和 Worker 健康状态追踪任务执行。

## 用户接口

Pi-Flow 通过 HTTP 提供用户接口，典型接入流程如下：

```text
选择智能体 → 创建工作区 → 创建会话 → 提交 Run
                                      ↓
                                订阅 SSE 实时输出
                                      ↓
                              按需回答问题或审批操作
                                      ↓
                               订阅返回的新 Run
```

下表路径均以 `/api/v1` 为前缀，并需携带 `Authorization: Bearer <token>`。

| 用户操作 | 接口 |
| --- | --- |
| 选择可用智能体 | `GET /agents` |
| 创建、浏览工作区 | `POST /workspaces`、`GET /workspaces` |
| 共享工作区 | `PUT /workspaces/{id}/members/{userId}` |
| 创建、浏览对话 | `POST /workspaces/{id}/sessions`、`GET /workspaces/{id}/sessions` |
| 读取对话历史与 Todo | `GET /sessions/{id}` |
| 发送消息 | `POST /sessions/{id}/runs`，Body 为 `{ "message": "…" }` |
| 查看实时输出或任务状态 | `GET /runs/{id}/events`、`GET /runs/{id}` |
| 取消任务 | `POST /runs/{id}/cancel` |
| 回答问题、批准或拒绝操作 | `POST /interactions/{id}/response`，Body 为 `{ "response": "…" }` |
| 列目录、上传、下载文件 | `GET /workspaces/{id}/files`、`POST /workspaces/{id}/files`、`GET /workspaces/{id}/files/{fileId}` |
| 查询、管理执行环境 | `/workspaces/{id}/sandbox`、`/workspaces/{id}/sandbox/snapshots`、`/sandbox-capacity` |
| 查询个人或任务用量 | `GET /usage`、`GET /runs/{id}/usage` |

管理员通过 `/admin/agents`、`/admin/skills`、`/admin/mcp-servers`、`/admin/audit`、`/admin/stats` 和 `/admin/usage` 管理配置与报表。完整方法、请求体、事件类型及错误码见 [API 文档](docs/api.md)。

浏览器客户端可使用 `fetch` 流式读取或支持认证头的 SSE 客户端。原生 `EventSource` 无法设置 Authorization 头。令牌到期后，携带新令牌和最后收到的事件 ID 重连。

## 快速开始

需要 **Node.js 24+** 和 npm。内存 Demo 无需模型密钥、数据库或 Cube 集群。

```bash
npm ci
npm run build
HARNESS_MODE=demo DEV_TOKEN=local-demo-token-2026 npm start
```

API 地址为 `http://127.0.0.1:8080`。Demo 自动提供一个演示智能体，并在 API 进程内运行 Worker，使用模拟模型和内存文件；重启后内存状态丢失。

在另一终端中创建第一段对话：

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

示例中的固定智能体 ID 仅用于 Demo。生产模式应从 `GET /api/v1/agents` 选择有权使用的已发布版本。

如需将 Demo 元数据保存到 PostgreSQL，可使用 Docker Compose；模拟文件仍保存在内存中：

```bash
DEV_TOKEN=local-demo-token-2026 docker compose -f compose.demo.yml up --build
```

## 接入真实服务

生产模式需要 PostgreSQL、模型网关、CubeSandbox，以及 UCS OIDC 或显式配置的隔离开发身份。复制 [.env.example](.env.example)，填写部署配置后运行：

```bash
cp .env.example .env
npm ci
npm run build
node --env-file=.env dist/migrate.js
node --env-file=.env dist/main.js
# 在另一终端或独立部署单元中运行：
node --env-file=.env dist/worker-main.js
```

API 与所有 Worker 必须使用相同数据库和能力策略。启动后，先通过管理 API 发布智能体，再创建会话。部署要求、技能卷、凭证和真实模型测试见 [部署文档](docs/deployment.md)。

## 开发验证

```bash
npm run check
npm test
npm run build
npm run smoke
```

Smoke 自动在 `18081` 端口启动并关闭 Demo，验证对话、SSE、幂等键和文件上传下载。部分测试需要 `openssl`、Python 3 和 Bash。真实 PostgreSQL 检查使用 `TEST_DATABASE_URL`，详见 [CI 文档](docs/ci.md)。

## 文档与当前状态

| 文档 | 内容 |
| --- | --- |
| [API 文档](docs/api.md) | REST 请求、SSE 事件、智能体配置与错误码 |
| [架构文档](docs/architecture.zh-CN.md) · [Architecture](docs/architecture.md) | 组件、数据模型、执行流程与安全边界 |
| [部署文档](docs/deployment.md) | 生产配置、升级要求与真实服务测试 |
| [用量与预算](docs/usage-budgets.md) | Token 核算、预算策略与费用估算 |
| [健康检查](docs/health.md) · [可观测性](docs/observability.md) | 探针、Worker 监控、指标和追踪 |
| [实现说明](docs/implementation.md) · [验收要求](docs/acceptance.md) | 实现记录、验证证据与待完成生产门禁 |
| [联调记录](docs/local-deployment.md) | 真实服务部署反馈 |

当前版本是可运行的联调基线，企业生产验收仍待完成。尚未提供内置前端、长期 Memory 或会话分支 API；文件接口不支持二进制文件。MCP 使用部署服务凭证，尚未实现用户委托 OAuth。预算报表提供成本估算，尚未对账供应商账单；实例快照不能替代工作区卷备份。

## 许可证

[Apache-2.0](LICENSE)。随工程打包的 SDK 来源与许可证见 [vendor/README.md](vendor/README.md)。
