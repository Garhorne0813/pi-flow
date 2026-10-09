# HTTP / SSE API

Base: `/api/v1`。除 `/health` 外，所有请求必须提供 `Authorization: Bearer <UCS JWT>`；Demo 使用 `DEV_TOKEN`。Tenant 只来自认证后的声明。所有 JSON 请求采用严格字段校验。错误形如：

```json
{
  "error": {
    "code": "SESSION_BUSY",
    "message": "SESSION_BUSY",
    "requestId": "req-1"
  }
}
```

响应包含 `X-Request-ID`。资源不存在和无权查看统一返回 404；viewer 的写操作返回 403。列表支持 `offset` / `limit`（默认 0 / 50，最大 100）；MCP 管理列表与统计除外。

## 接入闭环

```bash
curl -X POST http://127.0.0.1:8080/api/v1/workspaces \
  -H 'Authorization: Bearer local-demo-token-2026' \
  -H 'Content-Type: application/json' -d '{"name":"My workspace"}'

# 用返回的 Workspace ID 替换 <workspaceId>
curl -X POST 'http://127.0.0.1:8080/api/v1/workspaces/<workspaceId>/sessions' \
  -H 'Authorization: Bearer local-demo-token-2026' \
  -H 'Content-Type: application/json' \
  -d '{"agentVersionId":"00000000-0000-4000-8000-000000000001"}'

# 用返回的 Session ID 替换 <sessionId>
curl -X POST 'http://127.0.0.1:8080/api/v1/sessions/<sessionId>/runs' \
  -H 'Authorization: Bearer local-demo-token-2026' \
  -H 'Idempotency-Key: request-001' -H 'Content-Type: application/json' \
  -d '{"message":"Review the project"}'

curl -N 'http://127.0.0.1:8080/api/v1/runs/<runId>/events' \
  -H 'Authorization: Bearer local-demo-token-2026'
```

## 用户资源

| 方法       | 路径                                     | Body / 行为                                             |
| ---------- | ---------------------------------------- | ------------------------------------------------------- |
| GET        | `/agents`                                | 可使用的已发布版本，`{items:[]}`                        |
| GET/POST   | `/workspaces`                            | 列表 / 创建 `{name}`；创建 201                          |
| GET/DELETE | `/workspaces/{id}`                       | 获取 / owner 删除，必须无活跃 Run/租约                  |
| PUT        | `/workspaces/{id}/members/{userId}`      | owner 设置 `{role:"editor"\|"viewer"\|null}`；null 移除 |
| POST       | `/workspaces/{id}/sandbox/pause`         | 暂停空闲 Sandbox，204                                   |
| GET/POST   | `/workspaces/{id}/sessions`              | 列表 / 创建 `{agentVersionId}`，201                     |
| GET        | `/sessions/{id}`                         | Session、规范 Pi history entries、todos                 |
| POST       | `/sessions/{id}/runs`                    | `{message}`；接受 202，可选 Idempotency-Key             |
| GET        | `/runs/{id}`                             | 状态、错误码、父 Run、预算计数和时间戳                  |
| GET        | `/runs/{id}/events`                      | SSE；`Last-Event-ID` 或 `?after=<eventId>`              |
| POST       | `/runs/{id}/cancel`                      | 幂等取消；RUNNING 状态会异步收敛                        |
| POST       | `/interactions/{id}/response`            | `{response}`；审批为 approve / deny；返回新 Run，202    |
| GET        | `/workspaces/{id}/files?path=/workspace` | 列出目录，最多 1000 项                                  |
| POST       | `/workspaces/{id}/files`                 | UTF-8 `{path,content}`，返回 `{fileId}`，201            |
| GET        | `/workspaces/{id}/files/{fileId}`        | `{text,sha256}`（真实 Cube）；Demo `{text}`             |

幂等键以 Tenant + User + Session 为范围。同键同 message 返回原 Run；同键不同 message 返回 `IDEMPOTENCY_CONFLICT`。新的不同键在 Session 已有活跃 Run 时返回 `SESSION_BUSY`。文件 ID 是路径的 base64url 表示，不承担访问授权；下载仍检查 Workspace ACL 和 Sandbox 内真实路径。File API 只允许工作区路径；Skill 内容通过已授权 Agent 的 remote_read 读取。

## SSE 协议

```text
id: 17
event: message.delta
data: {"eventId":17,"runId":"...","sessionId":"...","type":"message.delta","timestamp":"2026-10-09T08:00:00.000Z","data":{"delta":"Hello"}}
```

| 类型                                     | data                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| run.queued / run.started / run.completed | 空对象；continued 时含 reason                          |
| run.failed / run.cancelled               | code（如有）                                           |
| message.delta                            | `{delta}`                                              |
| message.completed                        | `{message}`，Pi 原始消息结构                           |
| tool.started                             | `{name,callId}`                                        |
| tool.completed                           | `{name,callId,result}`                                 |
| tool.failed                              | `{name,callId,code}`                                   |
| interaction.required                     | `{interaction:{id,runId,kind,payload,resolved:false}}` |
| interaction.resolved                     | `{interactionId}`                                      |
| todo.updated                             | `{items:[{text,status}]}`                              |
| subagent.started / subagent.completed    | `{childRunId,state?}`                                  |

心跳为 `: heartbeat`，间隔约 15 秒。终态或 WAITING_INPUT 时服务端结束流。客户端根据 interaction ID 提交回答，并订阅响应里的新 Run ID。SSE 断连不取消 Run；重连使用最新 eventId。流期间访问撤销或存储错误会发送 `stream.error` 并关闭，客户端应重新请求 Run 状态。

浏览器原生 EventSource 无法直接加 Authorization 头；建议用 fetch streaming / SSE 客户端库。API 不接受 URL query token。

## 管理配置

管理员 JWT `roles` 中需含 `harness-admin`。

| 方法     | 路径                             | Body                                                   |
| -------- | -------------------------------- | ------------------------------------------------------ |
| GET/POST | `/admin/agents`                  | 列表 / 发布下例不可变配置                              |
| PUT      | `/admin/agents/{id}/status`      | `{enabled:boolean}`，即时撤销                          |
| PUT      | `/admin/agents/{id}/access`      | `{allowedUsers:["ucs-subject"]}`；空数组表示租户内可用 |
| GET/POST | `/admin/skills`                  | 列表 / 登记已发布 Skill 元数据                         |
| PUT      | `/admin/skills/{id}/status`      | `{enabled:boolean}`                                    |
| GET/POST | `/admin/mcp-servers`             | 列表 / 登记 Endpoint 引用和工具白名单                  |
| PUT      | `/admin/mcp-servers/{id}/status` | `{enabled:boolean}`                                    |
| GET      | `/admin/audit`                   | 分页行为审计；不保存 Prompt 或密钥                     |
| GET      | `/admin/stats`                   | Run 状态计数、平均耗时、待交互数和工具失败数           |

Agent 发布示例：

```json
{
  "name": "企业代码助手",
  "systemPrompt": "Help the user work with the authorized workspace.",
  "agentsMd": ["Follow the company coding standards."],
  "model": { "provider": "enterprise", "modelId": "coding-model" },
  "tools": [
    "read",
    "write",
    "edit",
    "bash",
    "ls",
    "grep",
    "find",
    "todo",
    "ask_user_question"
  ],
  "skills": [],
  "mcpServers": [],
  "subagents": [],
  "skillBundle": "default",
  "maxSteps": 30,
  "maxTokens": 100000,
  "timeoutSeconds": 600,
  "maxSubagents": 2,
  "maxDepth": 1
}
```

`maxSteps` 统计模型 turn 和实际工具执行，共享于父子任务树。Subagents 引用已发布 AgentVersion ID；委派能力需要 tools 中的 `delegate_to_agent`。每次发布生成新 UUID，不修改旧配置；access/status 是独立的治理字段，允许即时撤销。没有运行时扩展代码或自定义 URL 字段。

Skills 登记（不会上传或执行文件）：

```json
{
  "id": "review@v1",
  "name": "Review",
  "description": "Review code",
  "bundle": "default",
  "path": "/skills/review/v1/SKILL.md",
  "digest": "<64 lowercase hex characters>"
}
```

Skill 登记只保存元数据。生产部署必须在 `SKILL_VOLUMES_JSON` 为该 ID 配置一致的 Bundle 和路径；每个技能版本独占一个预发布 Volume，根目录存放 `SKILL.md` 和辅助文件。只有 Agent 的 `skills` 列表对应的 Volume 会被只读挂载到各自 SKILL.md 的父目录。Bundle 是租户授权分组，不是整包挂载源。重复或相互包含的挂载路径会在发布 Agent 时拒绝。空列表不挂载技能。

MCP 只发现该 Agent 的 `mcpServers` 列表；其他 Server 不出现在模型工具列表中，猜测工具名也不能调用或申请审批。子 Agent 使用父子 Server/技能列表的交集。管理 API 的注册目录仅供管理员管理，不作为 Agent 的工具发现目录。

MCP 登记：

```json
{
  "id": "kb",
  "endpointRef": "knowledge-base",
  "allowedTools": ["search", "get_document"]
}
```

`endpointRef` 必须存在于部署的 `MCP_ENDPOINTS_JSON`；不允许传入 transport、stdio command、OAuth Token 或 URL。

## Sandbox 生命周期与快照

下列路径均带 `/api/v1` 前缀；操作仍检查 Tenant 和 Workspace ACL，viewer 只能查询。实例创建仍按工具访问触发。

| 方法   | 路径                                                      | 行为                                                                  |
| ------ | --------------------------------------------------------- | --------------------------------------------------------------------- |
| GET    | `/sandbox-capacity`                                       | 用户/全局活跃使用量与部署策略；管理员额外看到本租户的不确定条目       |
| GET    | `/workspaces/{id}/sandbox`                                | 已记录的实例状态、最后使用时间与快照数量，不连接或唤醒实例            |
| POST   | `/workspaces/{id}/sandbox/pause`                          | 暂停，确认后释放活跃配额                                              |
| POST   | `/workspaces/{id}/sandbox/resume`                         | 检查配额后恢复/重建；不接受模型指定的技能/Volume                      |
| DELETE | `/workspaces/{id}/sandbox`                                | 释放实例，保留 Workspace Volume、Session 和快照                       |
| GET    | `/workspaces/{id}/sandbox/snapshots`                      | 只列出登记在当前 Workspace 的快照                                     |
| POST   | `/workspaces/{id}/sandbox/snapshots`                      | 创建，body 为 `{ "name": "checkpoint" }`，name 可省略                 |
| DELETE | `/workspaces/{id}/sandbox/snapshots/{snapshotId}`         | 删除当前 Workspace 的快照                                             |
| POST   | `/workspaces/{id}/sandbox/snapshots/{snapshotId}/restore` | 按当前技能授权检查快照，通过快照模板重建实例                          |
| POST   | `/workspaces/{id}/sandbox/snapshots/{snapshotId}/clone`   | body 为 `{ "name": "new workspace" }`；返回新 Workspace ID 与实例状态 |

快照管理/恢复/克隆不允许有未结束 Run；手动暂停/释放与空闲回收不允许 QUEUED/RUNNING Run 或正在使用的工具租约，WAITING_INPUT 可以暂停。恢复保留当前持久 Volume，不回滚工作区文件或 Session 历史。克隆分配独立的空 Workspace Volume。原 Workspace 删除时清理其实例、登记快照与 Volume。

活跃配额默认 owner 每租户 3 个、部署全局 100 个，包含预留/未知结果，暂停不计。默认空闲 15 分钟暂停、24 小时释放，Worker 每分钟扫描一次；参数见 `.env.example`。容量统计不暴露其他租户的 Workspace 或用户 ID。

配额超限返回 `USER_SANDBOX_LIMIT` / `GLOBAL_SANDBOX_LIMIT` (429)；快照数超限为 `SNAPSHOT_LIMIT` (429)。另有 `ACTIVE_RUNS` / `SANDBOX_OUTCOME_UNKNOWN` / `SANDBOX_NOT_CREATED` / `SNAPSHOT_SKILL_SCOPE_MISMATCH` (409)、`SNAPSHOT_NOT_FOUND` (404)、`SKILL_DENIED` / `BUNDLE_NOT_GRANTED` (403)。结果不确定的实例必须确认远端释放后才能退还容量；没有 ID 时需要运维对账。

## 常用错误码

`UNAUTHENTICATED` (401)、`INVALID_REQUEST` (400)、`WORKSPACE_NOT_FOUND` / `SESSION_NOT_FOUND` / `RUN_NOT_FOUND` (404)、`ADMIN_REQUIRED` / `READ_ONLY` (403)、`SESSION_BUSY` / `WORKSPACE_BUSY` / `CHECKPOINT_PENDING` (409)、`IDEMPOTENCY_CONFLICT` (409)。

Run 终态错误在 Run.error / run.failed 中给出，包括 `AGENT_REVOKED`、`ACTOR_TOKEN_EXPIRED`、`RUN_TIMEOUT`、`TOKEN_BUDGET_EXCEEDED`、`STEP_BUDGET_EXCEEDED`、`WORKER_LOST_UNKNOWN_TOOL_OUTCOME`、`REMOTE_CANCEL_UNCONFIRMED`。工具失败不一定立即结束 Pi：已确认的失败可以反馈给模型，未知副作用不应自动重试。
