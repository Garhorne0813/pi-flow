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
| GET        | `/logical-agents`                        | 可使用逻辑 Agent，`{id,activeVersionId}`，支持分页       |
| GET        | `/agents`                                | 可使用的已发布版本，`{items:[]}`                        |
| GET/POST   | `/workspaces`                            | 列表 / 创建 `{name}`；创建 201                          |
| GET/DELETE | `/workspaces/{id}`                       | 获取 / owner 删除，必须无活跃 Run/租约                  |
| PUT        | `/workspaces/{id}/members/{userId}`      | owner 设置 `{role:"editor"\|"viewer"\|null}`；null 移除 |
| POST       | `/workspaces/{id}/sandbox/pause`         | 暂停空闲 Sandbox，204                                   |
| GET/POST   | `/workspaces/{id}/sessions`              | 列表 / 创建 `{agentId}` 或兼容 `{agentVersionId}`，201                     |
| GET        | `/sessions/{id}`                         | Session、规范 Pi history entries、todos                 |
| POST       | `/sessions/{id}/runs`                    | `{message}`；接受 202，可选 Idempotency-Key             |
| GET        | `/runs/{id}`                             | 状态、错误码、父 Run、预算计数和时间戳                  |
| GET        | `/runs/{id}/events`                      | SSE；`Last-Event-ID` 或 `?after=<eventId>`              |
| POST       | `/runs/{id}/cancel`                      | 幂等取消；RUNNING 状态会异步收敛                        |
| POST       | `/interactions/{id}/response`            | `{response}`；审批为 approve / deny；返回新 Run，202    |
| GET        | `/workspaces/{id}/files?path=/workspace` | 列出目录，最多 1000 项                                  |
| POST       | `/workspaces/{id}/files`                 | UTF-8 `{path,content}`，返回 `{fileId}`，201            |
| GET        | `/workspaces/{id}/files/{fileId}`        | `{path,text,sha256}`（真实 Cube）；Demo `{text}`             |

幂等键以 Tenant + User + Session 为范围。同键同 message 返回原 Run；同键不同 message 返回 `IDEMPOTENCY_CONFLICT`。新的不同键在 Session 已有活跃 Run 时返回 `SESSION_BUSY`。文件 ID 是路径的 base64url 表示，不承担访问授权；下载仍检查 Workspace ACL 和 Sandbox 内真实路径。File API 只允许工作区路径；Skill 内容通过已授权 Agent 的 read 读取。文件 API 使用单独的临时无 Skill Sandbox，读操作不改变 Agent Sandbox 的 ID、scope、state 或 lastUsedAt，可与 Agent 工具并发；写操作保持工作区工具互斥。临时实例计入 owner/全局活跃配额，请求后确认释放；配额不足返回 429。失败清理保留容量记录，后续文件请求会先清理已知实例再创建；没有 ID 的未知结果仍需运维对账。

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

心跳为 `: heartbeat`，间隔约 15 秒。终态或 WAITING_INPUT 时服务端结束流。客户端根据 interaction ID 提交回答，并订阅响应里的新 Run ID。SSE 断连不取消 Run；重连使用最新 eventId。每次轮询使用只读数据库快照并重新检查 ACL，不锁定租户行、不更新 revision；请求结束审计保留为独立写事务。流期间访问撤销或存储错误会发送 `stream.error` 并关闭，客户端应重新请求 Run 状态。

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

Skill 登记只保存元数据。生产部署必须在 `SKILL_VOLUMES_JSON` 为该 ID 配置一致的 Bundle 和路径；每个技能版本选择一个预发布 Volume 或经部署 allowlist 批准的 `hostPath` 目录（两者互斥），根目录存放 `SKILL.md` 和辅助文件。只有 Agent 的 `skills` 列表对应的存储源会被只读挂载到各自 SKILL.md 的父目录。Bundle 是租户授权分组，不是整包挂载源。重复或相互包含的挂载路径会在发布 Agent 时拒绝。空列表不挂载技能。受信任的远程适配器在所有工具执行前验证已选 SKILL.md 的规范路径与摘要；read/grep 对实际读取的 manifest 字节再次校验，`..` 和指向 manifest 的符号链接别名遵循相同规则。无法确认登记 manifest 身份时返回 `SKILL_IDENTITY_UNCONFIRMED`，摘要不匹配返回 `SKILL_DIGEST_MISMATCH` (409)，不返回内容。登记 manifest 本身必须是规范路径下的普通文件，不能是符号链接；辅助文件在校验通过后仍可正常读取。bash 使用执行前校验，技能存储必须保持不可变。

Host 模式仅能通过部署环境配置 `SKILL_VOLUMES_JSON` 的 `hostPath` 和 `SKILL_HOST_ROOTS_JSON` 启用，Skill 登记与 Agent 发布请求不接受 `hostPath`/`volume` 字段；Agent 仍只指定 Skill ID，可混用两种后端。未经批准的源路径返回 `SKILL_HOST_PATH_DENIED`，不可访问、符号链接或特殊文件源返回 `SKILL_HOST_SOURCE_UNSAFE`，缺失或非只读挂载返回 `SKILL_HOST_MOUNT_UNCONFIRMED`。同一 Agent 所选 Skills 的目标冲突返回 `SKILL_MOUNT_CONFLICT`，源目录重复/嵌套返回 `SKILL_HOST_SOURCE_CONFLICT`。预检失败且实例已确认删除时释放配额，修正配置后可重试；删除无法确认时保留 `unknown` 配额及实例 ID（容量记录、工作区状态和审计日志）。源路径/后端变更触发实例重建；快照 scope 不一致拒绝恢复。Host 源目录必须在 API/Worker 与 Cubelet 上以相同路径共享同一文件系统；本版本不能验证的远程节点本地目录会被拒绝。完整目录、环境配置、注册/发布及节点生命周期示例见 [部署文档](deployment.md#local-host-skills--cubelet-宿主机技能目录)。

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

配额超限返回 `USER_SANDBOX_LIMIT` / `GLOBAL_SANDBOX_LIMIT` (429)；快照数超限为 `SNAPSHOT_LIMIT` (429)。文件实例清理未确认返回 `FILE_SANDBOX_CLEANUP_UNCONFIRMED` (502)，保留容量待清理。另有 `ACTIVE_RUNS` / `SANDBOX_OUTCOME_UNKNOWN` / `SANDBOX_NOT_CREATED` / `SNAPSHOT_SKILL_SCOPE_MISMATCH` (409)、`SNAPSHOT_NOT_FOUND` (404)、`SKILL_DENIED` / `BUNDLE_NOT_GRANTED` (403)。结果不确定的实例必须确认远端释放后才能退还容量；没有 ID 时需要运维对账。

## 常用错误码

`UNAUTHENTICATED` (401)、`INVALID_REQUEST` (400)、`WORKSPACE_NOT_FOUND` / `SESSION_NOT_FOUND` / `RUN_NOT_FOUND` (404)、`ADMIN_REQUIRED` / `READ_ONLY` (403)、`SESSION_BUSY` / `WORKSPACE_BUSY` / `CHECKPOINT_PENDING` (409)、`IDEMPOTENCY_CONFLICT` (409)。

Run 终态错误在 Run.error / run.failed 中给出，包括 `AGENT_REVOKED`、`ACTOR_TOKEN_EXPIRED`、`RUN_TIMEOUT`、`TOKEN_BUDGET_EXCEEDED`、`STEP_BUDGET_EXCEEDED`、`WORKER_LOST_UNKNOWN_TOOL_OUTCOME`、`REMOTE_CANCEL_UNCONFIRMED`。工具失败不一定立即结束 Pi：已确认的失败可以反馈给模型，未知副作用不应自动重试。

## MCP 发现与取消边界

Agent `mcpServers` 最多 16 项。Worker 将 Run 的 AbortSignal 与 deadline 传给 discovery；完整发现预算取剩余 Run 时间与 30 秒上限的较小值。每个 connect/listTools 请求仍最多等待 10 秒，分页最多 10 页，单 Server 白名单工具最多 100 个。发现开始、Server/分页循环和结果返回前检查取消；SDK 请求与实际 HTTPS fetch 都绑定信号，并以本地取消等待兜底。耗尽发现预算返回 `MCP_DISCOVERY_TIMEOUT`，耗尽 Run deadline 为 `RUN_TIMEOUT`；取消仍按 Run 取消状态处理。

连接和传输都尝试关闭，单次 cleanup 最多等待 250 ms；关闭异常不会覆盖原始取消/超时原因。配额相关过期回调不会释放或标记新请求的记录：所有转换绑定持久唯一 operation，CAS 接管失败返回 `CAPACITY_LEASE_LOST`。Sandbox 创建/连接期间取消时不执行工具；已返回 ID 的实例按取消策略确认清理后退还配额，创建无 ID 或 Kill 未确认返回 `REMOTE_CANCEL_UNCONFIRMED` 并保持保守占用。持久 Workspace Volume 不随取消删除。

## 逻辑 Agent 与任务版本

`POST /admin/agents` 创建逻辑 Agent 的首个不可变版本，响应增加 `agentId`。`POST /admin/agents/{agentId}/versions` 使用相同 AgentConfig Body 发布并激活后续版本；`PUT /admin/agents/{agentId}/active-version` 接受 `{agentVersionId}`，激活同逻辑 Agent 下已启用的版本（也可回滚）。普通发布和激活不禁用旧版本。`GET /logical-agents` 返回用户可用的 `{id,activeVersionId}`；原 `/agents` 与管理员列表保留版本列表供历史审计。

创建 Session 必须恰好提供 `agentId` 或兼容参数 `agentVersionId`。版本参数解析所属逻辑 Agent 的当前版本，不允许用旧版本选择器绕过生效规则。Session 返回 `agentId`、`effectiveVersionId` 及兼容别名 `agentVersionId`。新独立任务在同一事务中锁定最新版并更新有效版本；响应 Run 含 `agentVersionId`、能力快照 `capabilities`、`taskId`、`rootRunId`。续跑和子任务保留任务身份和版本（子任务使用父配置指定的不可变子版本），不触发 Session 升级。

`session.version.upgraded` SSE 事件与审计记录包含 `{from,to,timestamp,actor,reason:"new_root_task"}`。幂等重试不产生重复升级事件。未结束后代任务也会阻止原 Session 提交独立新任务。

跨 skillBundle 升级返回 409 `WORKSPACE_BUNDLE_MIGRATION_REQUIRED`，需创建与新 bundle 匹配的 Workspace；不静默迁移持久 Volume。共享 Workspace 中存在技能 scope 不兼容的未结束任务时返回 409 `WORKSPACE_VERSION_BUSY`，结束旧任务后重试。租约冲突返回 `WORKSPACE_BUSY`。相同 bundle 内的 scope 变化由现有 Sandbox 租约保护重建，保留 Volume；ACTIVE、PAUSED、RELEASED 都支持下一次使用配置适配。Sandbox pause/release 不触发升级，WAITING_INPUT 恢复仍使用原版本。

后续版本发布继承当前生效版本的 `allowedUsers`，不会因缺省 ACL 自动扩大用户访问范围。ACL 数组独立复制；管理员仍通过版本 access API 显式变更访问限制。Workspace 分别保存逻辑技能身份 `sandboxLogicalSkillScope` 与包含实际 Volume/Host 挂载配置的 `sandboxSkillScope`；新任务兼容性只比较逻辑身份，工具获取租约后仍由 Provider 校验实际挂载。旧记录缺少逻辑 scope 时从已有技能身份推导。

显式 `/workspaces/{id}/sandbox/resume` 是生命周期操作，不解析逻辑 Agent 最新版本，也不升级 Session。它在租约获取事务中选择 Workspace 记录的技能；全部仍授权时恢复原环境，任一技能已撤销或不属于当前 bundle 时改为不挂载任何技能的环境并保留 Volume。后续新任务按锁定版本适配技能环境；WAITING_INPUT 的原任务不切换版本，恢复交互仍执行动态撤销检查。此规则避免 Resume 被已撤销的旧技能阻塞，同时不会重新挂载被撤销技能。
