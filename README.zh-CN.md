<div align="center">
  <h1>Pi-Flow</h1>
  <p><strong>面向共享工作区的 AI 智能体后端。</strong></p>
  <p>通过 REST 与 SSE 提供持久化会话、流式执行、人工审批和远程工具调用。</p>
  <p>
    <a href="README.md">English</a>
    · <a href="#快速开始">快速开始</a>
    · <a href="#架构概览">架构概览</a>
    · <a href="#客户端接入">客户端接入</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A524-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24+" />
    <img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="Apache-2.0 License" />
  </p>
</div>

---

Pi-Flow 基于 Pi 运行智能体，使用 CubeSandbox 执行远程工具。开发者可接入自己的聊天客户端，管理员通过内置控制台管理版本化智能体、Skills 与 MCP 服务。

当前为 **0.1 后端集成基线**。Demo 使用模拟模型，无需外部服务即可体验接口流程；真实模型和远程执行需要部署相应服务。企业生产验收仍待完成。

## 核心能力

| 能力 | Pi-Flow 提供什么 |
| --- | --- |
| 流式对话 | 持久化会话、消息和工具事件、Todo、SSE 回放、幂等提交与任务取消 |
| 人工参与 | 写入、编辑、Shell 和 MCP 调用前审批，提问与回答后续跑 |
| 共享工作区 | owner / editor / viewer 权限，独立持久卷与工作区文件接口 |
| 远程执行 | CubeSandbox 文件与 Bash 工具，容量控制、暂停、恢复及空闲回收 |
| 版本化智能体 | 不可变版本、逻辑 Agent 生效版本切换，任务链固定执行版本 |
| 扩展能力 | 只读挂载的版本化 Skills、Streamable HTTP MCP 白名单与子智能体委派 |
| 管理与运维 | UCS OIDC 租户隔离、预算与用量、审计、指标和 Worker 健康状态 |

## 快速开始

需要 **Node.js 24+** 和 npm。内存 Demo 无需模型密钥、数据库或 Cube 集群。

```bash
git clone https://github.com/Garhorne0813/pi-flow.git
cd pi-flow
npm ci
npm run build
HARNESS_MODE=demo DEV_TOKEN=local-demo-token-2026 npm start
```

API 地址为 `http://127.0.0.1:8080`。Demo 自动提供一个演示智能体，并在 API 进程内运行 Worker，使用模拟模型和内存文件；重启后内存状态丢失。

打开 **http://127.0.0.1:8080/admin/ui**，输入上述 `DEV_TOKEN` 查看管理控制台。它用于管理配置；对话通过 API 或自行接入的聊天客户端进行。

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

示例中的固定逻辑智能体 ID 仅用于 Demo。生产模式应从 `GET /api/v1/logical-agents` 选择有权使用的智能体，使用返回的 `id` 作为 `agentId`。SSE 中的 `message.delta` 和 `run.completed` 事件表示已收到回复并完成任务。

如需将 Demo 元数据保存到 PostgreSQL，可使用 Docker Compose；模拟文件仍保存在内存中：

```bash
DEV_TOKEN=local-demo-token-2026 docker compose -f compose.demo.yml up --build
```

## 架构概览

```mermaid
flowchart LR
    Client[API 客户端 / 聊天前端] -->|REST / SSE| API[Fastify API]
    Console[管理控制台] --> API
    API <--> DB[(PostgreSQL)]
    Worker[Worker] <--> DB
    Worker --> Pi[Pi runtime]
    Pi --> Gateway[模型网关]
    API --> Cube[CubeSandbox / 工作区卷与宿主机技能]
    Worker --> Cube
    Worker --> MCP[Streamable HTTP MCP]
```

生产模式通常将 API 与 Worker 作为独立进程运行，使用相同数据库和能力策略。PostgreSQL 保存会话、任务和事件；工作区文件保存在独立持久卷中。Demo 在 API 进程内运行 Worker，使用模拟模型和内存 Sandbox。

组件、执行流程及安全边界见 [架构文档](docs/architecture.zh-CN.md)。

## 客户端接入

```text
选择逻辑 Agent → 创建工作区 → 创建会话 → 提交 Run → 订阅 SSE
                                                     ↓
                                             按需回答问题或审批
                                                     ↓
                                             订阅返回的新 Run
```

下表路径均以 `/api/v1` 为前缀，需携带 `Authorization: Bearer <token>`。

| 操作 | 接口 |
| --- | --- |
| 选择逻辑智能体 | `GET /logical-agents` |
| 创建工作区 | `POST /workspaces`，Body 为 `{ "name": "…" }` |
| 创建会话 | `POST /workspaces/{id}/sessions`，Body 为 `{ "agentId": "…" }` |
| 发送消息 | `POST /sessions/{id}/runs`，携带 `Idempotency-Key`，Body 为 `{ "message": "…" }` |
| 接收事件、查询状态 | `GET /runs/{id}/events`、`GET /runs/{id}` |
| 回答、批准或拒绝操作 | `POST /interactions/{id}/response`，Body 为 `{ "response": "…" }` |
| 取消任务链 | `POST /runs/{id}/cancel` |

Session 绑定稳定的逻辑 Agent。新独立任务使用当前生效版本；已经提交的任务及其审批续跑保持原版本。同一会话只允许一个活跃 Run。`GET /agents` 和 `{agentVersionId}` 会话选择器仍作为兼容接口提供；选择器不能与 `{agentId}` 同时传入。

审批或回答后，接口返回**新的 Run ID**，客户端需订阅新 Run。断开 SSE 不会取消任务；使用 `Last-Event-ID` 回放遗漏事件，显式取消则停止整个任务链。

浏览器客户端使用 `fetch` 流式读取或支持认证头的 SSE 客户端；原生 `EventSource` 无法设置 Authorization 头。令牌到期后，携带新令牌和最后收到的事件 ID 重连。

工作区共享、历史与 Todo、文件接口、Sandbox 管理、用量以及完整请求体和事件类型见 [API 文档](docs/api.md)。

## 管理控制台

服务启动后访问 **http://127.0.0.1:8080/admin/ui**（兼容 `/admin/agents/ui`）。Demo 使用 `DEV_TOKEN`；生产使用具备 `harness-admin` 角色的 UCS JWT。控制台无需独立前端构建。

可管理 Agent 版本与访问范围、Skills、MCP 服务和子 Agent 委派，查看部署能力并保存新 Agent 草稿的租户默认值。部署凭证、卷、Endpoint 与权限上限仍由服务端配置。

操作细节、令牌处理与配置冲突规则见 [管理控制台文档](docs/admin-console.zh-CN.md)。

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

API 与所有 Worker 必须使用相同数据库和能力策略。启动后，先通过管理 API 发布智能体，再创建会话。部署要求、技能宿主机目录（默认）或卷、凭证和真实模型测试见 [部署文档](docs/deployment.md)。

## 当前状态与限制

- 提供管理控制台；聊天前端需自行接入。尚未提供长期 Memory 或会话分支 API。
- 文件接口需先创建会话，仅支持不超过 **256 KiB** 的 UTF-8 文件，不支持二进制文件。
- 子智能体使用父子权限交集、共享任务预算和级联取消，目前顺序执行，不能等待用户交互。
- MCP 使用部署服务凭证，用户委托 OAuth 尚未实现。
- 预算与报表提供 Token 核算和成本估算，尚未对账供应商账单。
- 实例快照恢复保留当前工作区文件与历史，不能替代卷或数据库备份；Cube 当前拒绝跨工作区快照克隆。

生产门禁及验证证据见 [验收要求](docs/acceptance.md)。

## 开发验证

```bash
npm run check
npm test
npm run build
npm run smoke
```

Smoke 自动在 `18081` 端口启动并关闭 Demo，验证对话、SSE、幂等键和文件上传下载。部分测试需要 `openssl`、Python 3 和 Bash。真实 PostgreSQL 检查使用 `TEST_DATABASE_URL`，详见 [CI 文档](docs/ci.md)。

原生表单校验回归测试在安装 Chromium（`/usr/bin/chromium`、`/usr/bin/chromium-browser` 或通过 `CHROMIUM_PATH` 指定）时运行。测试使用开发依赖 `playwright-core`，不会下载浏览器；未安装 Chromium 时仅跳过原生浏览器测试。

## 文档

| 文档 | 内容 |
| --- | --- |
| [API 文档](docs/api.md) | REST 请求、SSE 事件、智能体配置与错误码 |
| [架构文档](docs/architecture.zh-CN.md) · [Architecture](docs/architecture.md) | 组件、数据模型、执行流程与安全边界 |
| [部署文档](docs/deployment.md) | 生产配置、升级要求与真实服务测试 |
| [用量与预算](docs/usage-budgets.md) | Token 核算、预算策略与费用估算 |
| [健康检查](docs/health.md) · [可观测性](docs/observability.md) | 探针、Worker 监控、指标和追踪 |
| [实现说明](docs/implementation.md) · [验收要求](docs/acceptance.md) | 实现记录、验证证据与待完成生产门禁 |
| [联调记录](docs/local-deployment.md) | 真实服务部署反馈 |
| [管理控制台](docs/admin-console.zh-CN.md) · [Management console](docs/admin-console.md) | 版本发布、访问控制、Skills、MCP 与配置默认值 |

## 贡献

欢迎提交 Issue 和 PR。修改后运行相关测试，以及 `npm run check` 和 `npm run build`；运行行为变更应包含回归覆盖。验证流程见 [CI 文档](docs/ci.md)。

## 许可证

[Apache-2.0](LICENSE)。随工程打包的 SDK 来源与许可证见 [vendor/README.md](vendor/README.md)。
