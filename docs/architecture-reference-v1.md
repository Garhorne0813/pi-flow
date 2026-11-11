> 历史参考：以下为简化前的目标架构，不再作为当前改造契约。当前设计见 [implementation_doc.md](implementation_doc.md)。

# pi-flow 架构（简洁版）

> 依据仓库 `pi-flow-main` 源码（commit `6f6bf54`，2026-11-09）整理。
> 产品名：**Personal Agent Platform**（包名 `personal-agent-platform`，仓库/部署名 `pi-flow`）。
> 目标：用一页到几页的篇幅讲清楚“有哪些进程、数据怎么流、边界在哪里、为什么这样设计”。

---

## 1. 定位

pi-flow 是一个**面向多用户的个人 AI Agent 后端**，只交付 HTTP/SSE 契约，不自带 Web 前端。

- 每个用户拥有一个私有的、持久的 `/workspace`；
- 用户与平台在 Git 中定义的 **Agent** 交互；
- Agent 可以读写文件、执行命令、联网、查 Skill、调 MCP、委派子 Agent；
- 高风险操作默认需要用户显式审批；
- 计算（沙箱）可随时替换，用户数据永不随沙箱销毁。

技术栈：Node.js ≥ 24、TypeScript（ESM、strict）、Fastify 5、PostgreSQL（`pg`）、Zod、`@earendil-works/pi-coding-agent`（vendored pi SDK）、`node:test`。

---

## 2. 五条核心设计原则

| 原则 | 含义 |
| --- | --- |
| **Agent 在沙箱之外** | 模型调用、Prompt 拼装、编排、审批、凭证、策略全部在受信任的 Worker 进程；沙箱只执行工具命令。安全边界在模型影响不到的代码里。 |
| **Agent 由 Git 定义且不可变** | Agent 配置（模型、工具、Skill、MCP、限额、审批模式）发布为内容寻址（SHA-256）的不可变版本；Session/Run 钉住版本，部署升级不会改变进行中的任务语义。 |
| **每人一个持久工作区** | `/workspace` 是逻辑身份，挂载在 OSS / 块卷 / 宿主目录上；沙箱只是可替换的执行载体。 |
| **控制面与数据面分离** | API/Worker 是控制面，负责状态、事件、策略；沙箱是数据面，只跑命令。 |
| **默认拒绝、显式放行、全程审计** | `write`/`edit`/`bash`/MCP 默认逐次审批；Agent 可配置 `guarded`/`auto`，但每次都留审计；平台级 kill-switch 对钉住旧版本的 Run 仍生效。 |

---

## 3. 进程与部署拓扑

```text
                    ┌──────────────────────────────┐
   Client ──HTTP/SSE─│  API 进程 (src/main.ts)       │
                    │  Fastify, /api/v1, SSE        │
                    │  认证 / 路由 / 审计 / 文件 API │
                    └──────────────┬───────────────┘
                                   │ SQL (personal_*, platform_*)
                    ┌──────────────▼───────────────┐
                    │  PostgreSQL（唯一协调点）      │
                    │  Run/Session/Event/Lease/...  │
                    └──────────────┬───────────────┘
                                   │ 轮询 + 行锁 + pg_notify
                    ┌──────────────▼───────────────┐
                    │  Worker 进程 (src/worker-main.ts) │
                    │  认领 Run、驱动模型、执行工具   │
                    └───┬───────────┬───────────┬───┘
                        │           │           │
                 LLM 网关(OpenAI 兼容)  沙箱 Provider      MCP / Web
                                        (Aliyun E2B / Cube / demo)
                                        │
                                  用户持久存储 (OSS / volume / hostpath)
```

- **API 进程**：无状态（除缓存），可水平扩展；`GET /runs/:id/events` 直接从数据库回放并通过 `pg_notify` 唤醒。
- **Worker 进程**：可多实例，彼此不通信，通过数据库租约/认领竞争任务；`WORKER_CONCURRENCY` 控制单进程并发（默认 4）。
- **单进程模式**：`INLINE_WORKER=true` 或 `HARNESS_MODE=demo` 时 Worker 在 API 进程内运行（`main.ts` 调 `worker.start()`）。
- **demo 模式**：无外部依赖，使用内存 Store、DemoRuntime、DemoSandbox、内存存储；启动时自动从 `config/` 同步 Agent。
- **生产模式**：必须有 `DATABASE_URL`，Agent 配置由 `config:sync` / 管理端发布，Worker 独立部署。

---

## 4. 代码模块地图

| 目录 | 职责 |
| --- | --- |
| `src/api/` | Fastify 路由：agents、sessions/runs/interactions/events(SSE)、schedules、me（文件/沙箱/记忆）、admin（配置/Skill/审计/指标） |
| `src/execution/` | `HarnessService`（领域操作 + 事务）、`Worker`（认领与执行循环）、`Runtime`（Pi SDK / Demo）、`DeltaBatcher`、记忆读写/整理 |
| `src/sandbox/` | `UserSandboxManager`（生命周期/租约/围栏/对账）、Provider 适配器、网络策略、远端 Python 脚本 |
| `src/storage/` | 工作区后端：OSS / volume / hostpath / memory |
| `src/storage/` | `Store` 接口与 `MemoryStore` / `PostgresStore`；`ScheduleStore`；Run/Session/平台配置读写 |
| `src/config/` | Git 配置加载/校验/发布、管理端配置文档、Skill 交付 |
| `src/skills/` | Skill 版本、归档、原子物化、管理上下文 |
| `src/security/` | 认证（OIDC/DEV_TOKEN）、Principal、策略网关、工具风险、Token 保险箱、路径策略 |
| `src/tools/` | 内置工具 schema、MCP 管理、Web 工具、结构化提问 |
| `src/schedules/` | cron 解析、用户侧服务、Worker 侧触发器 |
| `src/observability/` | 健康探针、Worker 心跳、指标、告警 |
| `src/domain/usage.ts` | 用量账本、预算准入与结算 |
| `migrations/` | 顺序 SQL（`harness_*` 旧表 + `personal_*` 现表 + `platform_*`） |

---

## 5. 核心领域模型

```text
AgentDefinition (逻辑 Agent, key)
   └── AgentVersion (不可变, digest)      ← Run 钉住
Session (userId, agentId, cwd, entries, effectiveVersionId)
   └── Run (一轮用户输入, 钉住 agentVersionId/configDigest/model)
         ├── 子 Run (parentRunId, depth+1)      ← delegate_to_agent
         └── 续跑 Run (resumedFrom=interactionId) ← 审批/提问后
```

| 对象 | 关键字段/语义 |
| --- | --- |
| **Session** | 绑定 Agent、项目目录 `cwd`、Pi transcript `entries`；`effectiveVersionId` 在每次新的根 Run 时升级到当前 active 版本（发 `session.version.upgraded` 事件）。 |
| **Run** | 状态 `QUEUED → RUNNING → COMPLETED / FAILED / CANCELLED`，等待交互时 `WAITING_INPUT`；记录 `taskId/rootRunId` 把续跑、子 Agent 归入同一任务链；`steps/tokens/children/depth/deadline` 逐级受限。 |
| **Interaction** | `question` 或 `approval`；使 Run 停在 `WAITING_INPUT`；同一 Run 同时只保留一个未解决交互（并行工具调用复用首个卡片）。 |
| **ScheduledTask / Fire** | 用户定时任务定义；每次到期产生一条 Fire，最多关联一个普通根 Run。 |
| **Lease** | 用户级（旧模式，串行化一个用户的执行）或会话级（多会话模式）；带 fencing token，跨进程互斥。 |
| **Event** | 每个 Run 的有序事件日志；`event_id` 是**每用户**稠密递增游标，`seq` 是 Run 内序号。 |

### Run 任务链与预算

- `taskId`/`rootRunId` 标识整条链；取消会沿任务链级联。
- 步骤/Token/子 Agent 数量/深度都同时受当前 Run 与根 Run 预算约束；子 Agent 的 `maxSteps/maxTokens/timeout` 取父子较小值。
- V1 子 Agent 不能再委派（`delegate_to_agent` 被移除），`maxDepth=0` 即禁用。

---

## 6. 请求与执行生命周期

### 6.1 提交一次对话

1. `POST /api/v1/sessions`：校验 Agent、规范化 `cwd`（逻辑 `/workspace/...`），创建 Session，初始版本为当前 active 版本。
2. `POST /api/v1/sessions/:id/runs`：
   - 在轻事务内创建 Run：校验 Agent/版本/Skill/MCP 可用性，解析模型，写 `run.queued` 事件；
   - `Idempotency-Key` 可重放同一 Run；同一 Session 同时只允许一个非终态 Run（部分唯一索引 `personal_runs_session_busy`），冲突返回 `409 SESSION_BUSY`；
   - 调用者 Bearer 仅在 Agent 开启 `userTokenAccess` 时以 AES-256-GCM 密封存入 `userTokenRef`。

### 6.2 Worker 认领

```text
每 250 ms tick:
  listClaimableRuns(now, 64)          -- 数据库全局扫描
  → 按 lease 获取用户/会话执行权
  → runTx: QUEUED → RUNNING, 写 lease, 发 run.started
  → 并发执行（受 WORKER_CONCURRENCY 限制）
```

- 心跳每秒续租 Run lease，并检查 `cancelRequested`；每 5 次心跳做一次完整授权复核（Token 过期、Agent/Skill/MCP 撤销）。
- Run 超过 `deadline`（Agent `timeoutSeconds`）被中止，标记 `RUN_TIMEOUT`。
- Worker 崩溃导致 lease 过期：Run 被标记 `FAILED / WORKER_LOST_UNKNOWN_TOOL_OUTCOME`，绝不猜测工具是否执行。

### 6.3 执行一轮

```text
Worker.execute
  ├─ 读取 Session transcript / 钉住的 AgentConfig / Skill / 平台规则
  ├─ MCP discover（仅白名单工具；token 留在 Worker）
  ├─ 读取记忆索引（只注入 MEMORY.md，不注入所有主题文件）
  ├─ PiRuntime.execute
  │    ├─ SessionManager.inMemory 加载持久化 entries
  │    ├─ EnterpriseResourceLoader 注入 system prompt / AGENTS.md / Skill 提示
  │    ├─ 每次模型请求前: UsageLedger.reserve(用户+平台预算)
  │    └─ 自定义工具 → Worker.executeTool → 沙箱 / MCP / Web / 委派
  ├─ SSE 事件逐条持久化；transcript 每 200 ms 合并 checkpoint
  └─ COMPLETED / FAILED / WAITING_INPUT
```

- Pi SDK 的自动压缩（compaction）开启；压缩前后发 `session.compaction.*` 事件并强制 checkpoint。
- 图片以 image content block 交给模型；持久化 transcript 中替换为占位符，避免历史膨胀。

### 6.4 审批 / 提问与续跑

```text
工具需要审批
  → defer("approval")：Run 置 WAITING_INPUT，写 Interaction，
    发 interaction.required，然后中止当前执行
客户端 POST /interactions/:id/response {response}
  → 事务：标记 resolved；旧 Run 置 COMPLETED(reason=continued)；
    创建续跑 Run（resumedFrom=interactionId，继承版本/能力/步骤/Token/任务链）
Worker 执行续跑：
  - approve：按 Interaction 中记录的**精确工具载荷**执行一次，然后继续模型循环
  - deny：不执行，把结果告诉模型
  - question：把 "User response: ..." 作为下一轮输入
```

关键点：

- 审批与具体工具载荷绑定并审计；批准后的操作只重放一次，`MCP_OUTCOME_UNKNOWN` / `REMOTE_CANCEL_UNCONFIRMED` 永不重放。
- `deny` 模式下定时任务直接失败关闭；`guarded` 低风险自动放行；`auto` 全部放行，但都会写 `tool.auto_approved` 审计。
- 定时任务与子 Agent 不允许产生交互（`SCHEDULED_INTERACTION_UNSUPPORTED` / `SUBAGENT_INTERACTION_UNSUPPORTED`）。

### 6.5 失败语义

| 情况 | 结果 |
| --- | --- |
| 工具参数/路径/策略拒绝 | `tool.failed`，错误返回模型，Run 可继续 |
| 步骤/Token/记忆写入超限 | `429 STEP_BUDGET_EXCEEDED` / `TOKEN_BUDGET_EXCEEDED` / `MEMORY_WRITE_LIMIT` |
| 远程结果不确定 | Run `FAILED`，沙箱进入 `unknown/quarantined`，等待对账 |
| 用户取消 | 任务链上所有非终态 Run 置 `cancelRequested`，非 RUNNING 立即 `CANCELLED` |
| Worker 租约丢失 | `LEASE_LOST` / `WORKER_LOST_UNKNOWN_TOOL_OUTCOME` |

---

## 7. 事件与 SSE

- 所有状态变化、消息增量、工具结果写入 `personal_run_events`；事件 id 与状态变更同事务。
- **event_id**：每用户稠密递增，同时作为 SSE `id:` 与断点游标；**seq**：Run 内从 1 开始，保证 Run 内顺序。
- `message.delta` 先批处理：200 ms 或 8192 字符 flush；工具/交互/终态事件写入前先 flush，保证顺序。
- `GET /api/v1/runs/:id/events?after=<eventId>` 或 `Last-Event-ID`：
  - 每页最多 100 条，按 event_id 排序；页间重新授权；
  - 短页时 `pg_notify('harness_run_event')` 唤醒 + 2 s 轮询兜底；
  - Run 终态或 `WAITING_INPUT` 且追平后结束；约 15 s 无事件发 `: heartbeat`；
  - 断开不会取消 Run，重连精确续传。

主要事件：`run.*`、`message.delta/completed`、`tool.started/completed/failed`、`tool.dispatching/dispatched/confirmed/unknown`、`interaction.required/resolved`、`session.compaction.*`、`todo.updated`、`subagent.started/completed`。

---

## 8. Agent 配置与发布

### 8.1 Git 配置树

```text
config/
├── base/HOUSE.md                    # 平台底线规则，注入每个 Agent，随版本发布
├── agents/<key>/agent.yaml          # 模型/工具/Skill/MCP/审批/限额
├── agents/<key>/SYSTEM.md           # 权威系统提示词
├── agents/<key>/AGENTS.md           # 工作细则
├── agents/<key>/subagents/<name>.md # 内联子 Agent
├── skills/<id>/SKILL.md             # 平台只读 Skill
└── mcp/servers.yaml                 # MCP 注册与工具白名单
```

`npm run config:sync` 先校验整棵树，再在单个事务中发布；任何一项无效则整次拒绝，上一版继续生效。

### 8.2 两套发布入口，一个权威源

| 入口 | 用途 |
| --- | --- |
| `npm run config:sync`（CLI，读 Git 树并直接发布） | 传统部署、demo 自动同步；`--check` 只校验 |
| `npm run config:import`（一次性导入） | 用 `--from-db` 或 `--from-git` 把旧配置转成管理端可编辑文档 |
| `POST /api/v1/admin/config/global`、`/agents`（管理端） | 生产主路径：编辑 → 校验 → 发布，带 revision/发布历史/审计 |

- 两个独立作用域：`global`（平台规则、LLM 目录、MCP 端点、策略、沙箱网络/模板）与 `agents`（Agent 草稿）。
- 发布后物化为 `personal_agent_definitions/versions`；**数据库是运行时权威**，环境变量 `LLM_*` 只在目录为空时作为兼容回退。
- Run 创建时钉住 `agentVersionId + configDigest + model`；模型引用 `default` 每次 Run 解析当前默认，`fixed` 钉住版本内模型。

### 8.3 AgentConfig 能力面

`model`、`tools`、`skills`、`mcpServers`、`approval.mode`（`user`/`guarded`/`auto`）、`memory`（开关/范围/限额）、`subagents`/`subagentDefinitions`、`maxTokens/maxSteps/timeoutSeconds/maxSubagents/maxDepth`、`userTokenAccess`。

---

## 9. 工具执行管线

内置工具：`read / write / edit / bash / ls / grep / find / todo / ask_user_question / delegate_to_agent / web_search / web_fetch`。

每次调用都经过同一条管线：

```text
1. 定时任务 allowlist 检查（可选，MCP 默认被排除）
2. 平台策略网关：全局 disabledTools kill-switch + Agent 工具白名单
3. 参数 schema 校验（Zod）
4. 记忆路径规则（保留 MEMORY.md/索引区；scope 校验）
5. edit 预校验（oldText 必须唯一，避免“只能失败的审批卡”）
6. 审批决策（user = 每次；guarded = 风险启发式；auto = 全放行；定时任务 deny/guarded/auto）
7. 步骤预算（Run + 根 Run）
8. 分派：
   - web_*        → 控制面执行
   - mcp_*        → MCP 白名单工具调用（token 在 Worker）
   - todo         → 会话级清单
   - ask_user_question → 创建 Interaction
   - delegate_to_agent → 创建子 Run 并同步执行
   - 其余         → UserSandboxManager.executeTool
9. 事件 tool.started/completed/failed；安全动作写审计
```

### MCP

- Streamable HTTP 端点，按 Agent 的 `mcpServers` 与注册表 `allowedTools` 双重白名单发现；工具名映射为 `mcp_<server>_<tool>`。
- 每次 Run 建连/发现，可复用连接；调用阶段发 `tool.dispatching/dispatched/confirmed/unknown`。
- 结果不确定标记 `unknown` 并使整个 Run 失败，不自动重放。

### 子 Agent

- 来源：父 Agent 版本内的 `subagents/*.md`，或父 Agent 引用的 Skill 内置 `agents/<name>.md`（寻址 `skill:<skill-id>:<name>`，按 Skill 当前 active 版本解析，Skill 发版无需重发 Agent）。
- 子 Agent 有自己的 Session 与 Run，共享用户/沙箱/任务链，但工具、限额、提示词都是父级的子集。

---

## 10. 沙箱与工作区

### 10.1 Provider 与存储矩阵

| 层 | 实现 | 说明 |
| --- | --- | --- |
| 沙箱 | `aliyun-e2b`（生产目标）、`cube`（过渡）、`demo`（内存） | 统一 `SandboxProvider` 接口：create/connect/execute/terminate/inspect/pause/resume/readFile/updateNetwork |
| 存储 | `oss`（阿里云动态挂载）、`volume`（Cube 卷）、`hostpath`（宿主目录/NFS）、`memory` | 统一 `UserStorageProvider`，用户 UUID 推导前缀/卷名，沙箱生命周期永不删除数据 |
| Skill 挂载 | `oss` / `volume` / `hostPath` | 平台级只读树，所有沙箱一致，不随 Agent 变化 |

### 10.2 生命周期状态与不变量

状态：`absent → creating → ready ⇄ busy → paused / stopping → absent`，异常进入 `unknown / quarantined / error`。

硬性不变量：

1. **同一用户目录只有一个写者**：新持有者必须先围栏（fence）无法确认的旧写者，否则拒绝服务。
2. **代次 CAS**：每次创建递增 `generation`；迟到创建结果只登记为 orphan，绝不写入当前绑定。
3. **unknown 不会静默变 absent**：不确定状态必须终止并核实，否则 quarantine，等待 `npm run sandbox:reconcile`。
4. **出网由 Provider 防火墙强制**：`unmanaged / open / none / allow-list / deny-list`，创建时下发，维护扫描持续收敛；管理端可全局发布覆盖。
5. **模板只影响新建实例**：全局 `sandboxTemplate` 覆盖环境变量；已有实例保留创建时模板。
6. **空闲回收**：`sweepIdle` 暂停/释放，`maxActiveTotal` 限制全局活跃数。

### 10.3 租约模型

| 模式 | 互斥粒度 | 行为 |
| --- | --- | --- |
| 默认（`SANDBOX_MULTI_SESSION=false`） | 用户 | 一个用户同一时间只有一个 Run 或文件操作；用户租约同时是 Run 锁和沙箱生命周期锁。 |
| 多会话（`true`） | 会话 | 同一用户不同 Session 可在同一沙箱并发；用户租约退化为沙箱生命周期锁（创建/暂停/释放），文件 API 用合成会话租约。 |

租约带 fencing token 与 TTL，心跳续租；丢失租约立即中止执行。

### 10.4 工具在沙箱内如何执行

`UserSandboxManager.executeTool` → 获取/复用实例 → `provider.execute(operation, args, _workspaceRoot, _skillManifests, dataToken)` → 沙箱内运行受控 Python 脚本：

- 逻辑前缀 `/workspace` 映射到真实挂载点；`..`、NUL、绝对逃逸在控制面与沙箱内**双重校验**；
- 文件工具限定在工作区、只读 Skill 树与临时 `/tmp` scratch；
- Skill 树校验 `SKILL.md` 摘要、`.pa-skill.json` 接受摘要，并通过“尝试写入必须失败”证明只读挂载；
- `bash` 有超时与输出上限，环境变量最小化；开启 `userTokenAccess` 的 Agent 额外获得 `$USER_TOKEN`。

---

## 11. 安全模型

### 11.1 身份与认证

- 外部身份 = `(issuer, subject)`，映射到内部不可复用 UUID（`personal_users`）；v1 没有租户/成员/共享工作区。
- 两种认证：
  1. **OIDC/OAuth2 JWT**：`UCS_JWKS_URL` + `UCS_ISSUER` + `UCS_AUDIENCE`，校验 `exp/sub`；
  2. **固定 `DEV_TOKEN`**：仅隔离部署/Demo，绑定单一身份。
- `UCS_ADMIN_USER_IDS` / `UCS_ADMIN_ROLE_KEYS` 授予平台管理员权限；管理端路由强制 `admin()`。
- 跨用户资源统一返回 `404`，不泄漏存在性。

### 11.2 纵深防御

| 层 | 控制 |
| --- | --- |
| 平台策略 | `PolicyGateway`：全局 `disabledTools` kill-switch + Agent 工具白名单，每次工具调用在沙箱外复核（钉住旧版本也逃不掉）。 |
| Agent 能力 | 不可变版本中的工具/Skill/MCP/限额/审批模式；Skill/MCP 撤销后 Run 重新校验时失败。 |
| 人工审批 | `write/edit/bash/MCP` 默认逐卡审批；批准绑定精确载荷；`guarded` 用保守启发式，无法判断即视为风险。 |
| 沙箱 | 路径策略 + 只读 Skill 挂载 + Provider 网络防火墙；Provider 不持有模型密钥。 |
| 凭证 | LLM/MCP token 留在 Worker；`CONFIG_SECRET_KEY` 加密平台密钥；调用者 token 仅对 opt-in Agent 的 bash 暴露，Run 终态即清除。 |
| 审计 | 每个认证请求批量写审计；安全动作（自动放行、记忆写入、沙箱围栏/不确定结果）直接写审计。 |

---

## 12. 数据模型（PostgreSQL）

平台配置（跨用户）：

| 表 | 用途 |
| --- | --- |
| `platform_config` / `platform_config_publications` | global/agents 两作用域当前文档、revision、发布历史 |
| `platform_secrets` | 加密后的 LLM/MCP 密钥 |
| `personal_agent_definitions` / `personal_agent_versions` | 物化后的逻辑 Agent 与不可变版本 |
| `personal_skills` / `personal_skill_versions` / `personal_skill_archives` / `personal_skill_publications` | Skill 注册、版本、归档、发布历史 |
| `personal_mcp_servers` | MCP 注册与白名单 |

用户数据（均带 `user_id`，外键级联）：

| 表 | 用途 |
| --- | --- |
| `personal_users` | 身份映射与状态 |
| `personal_user_storage` | 持久工作区身份（kind/location/mountDir） |
| `personal_user_sandboxes` / `personal_sandbox_operations` | 当前沙箱绑定（generation/state/lease/commandOwner/dataToken）与操作记录 |
| `personal_sessions` | Session 元数据 + transcript JSON |
| `personal_runs` | Run 元数据 + 快照 JSON；状态/lease/幂等键/会话忙碌唯一索引 |
| `personal_run_events` / `personal_event_sequences` | 事件日志与每用户 event_id 游标 |
| `personal_user_state` | 仅 `interactions` / `todos` 等用户级标量元数据 |
| `personal_user_leases` / `personal_session_leases` | 跨进程执行互斥与 fencing |
| `personal_audit_logs` | 审计 |
| `personal_usage_counters` | 日/月 Token/成本/请求计数（提交与结算近似） |
| `personal_memory_usage` | 记忆文件读取/校验记录 |
| `personal_worker_health` | Worker 心跳 |
| `personal_scheduled_tasks` / `personal_schedule_fires` | 定时任务定义与触发记录 |

旧共享工作区时代的 `harness_*` 表保持原样，不做自动数据归属迁移。

**并发模型**：`txLight`（只锁相关 Session/Run，不加载全量历史）用于提交、事件、心跳；`runTx`（锁用户状态 + 指定 Run）用于执行期状态变更；`tx`（用户级全量）用于少见的重操作。事件游标推进与事件写入同事务。

---

## 13. 定时任务

- 用户对象：Agent、cron（严格 5 段）、时区、prompt、`cwd`、`sessionMode=reuse|new`、审批模式、工具 allowlist、jitter、misfire 策略、结束条件。
- 调度器寄居在 Worker tick 中（无独立进程、无 leader 选举）：`claimDueSchedules` 用数据库唯一约束 `(schedule_id, trigger, scheduled_for)` 抢占；`claimed` 超时由恢复扫描重试。
- 每次触发只走普通 Run 路径（`submitScheduled`），因此继承全部沙箱/预算/审计机制；区别：
  - 无人值守，**永不产生审批卡**：`deny` 失败关闭、`guarded` 只放行低风险、`auto` 放行；
  - 不支持 `userTokenAccess`，不支持 `ask_user_question`；
  - 会话可复用（同一 `sessionMode=reuse`）或每次新建。
- 连续失败达到阈值自动禁用；`SESSION_BUSY` 等跳过不计失败；提供容量预览（`maxActive × (1 - interactiveReserve)`）。

---

## 14. 记忆（Memory）

- 位置：用户级 `/workspace/memory/`，项目级 `<cwd>/memory/`；`MEMORY.md` 是索引，主题文件带 frontmatter（type/status/created/updated）。
- Agent 通过 `memory` 配置决定启用、作用域、单文件/总大小/文件数/索引大小/每 Run 写入次数。
- 模型只看到索引（启动时注入），主题文件按需 `read`；写入经平台规范化、生成/更新索引，并记录读取使用情况。
- 记忆主题写入是唯一自动放行的写面（仍审计）；索引/归档/日志路径对模型保留。
- Worker 周期任务（`MEMORY_CONSOLIDATION_*`）逐用户加执行租约整理：去重、失效/归档、修复索引；内容**不进入** AgentConfig，不影响版本 digest。

---

## 15. Skill

- 来源：Git `config/skills/<id>/`（同步/交付）或管理端上传（ZIP）。
- 版本：不可变 `personal_skill_versions`，含内容摘要、`SKILL.md` 摘要、文件清单（path/size/mode/sha256）、文件数/大小；归档可存 DB 或文件系统。
- 交付：`SkillMaterializer` 原子写入交付根（临时目录 + rename），`SkillDelivery` 把 Git 树镜像到只读挂载源；沙箱内每次运行校验摘要与只读性。
- `disable-model-invocation: true`：仍注册/交付，但从模型自动推荐提示中隐藏。
- Skill 可携带子 Agent（`agents/<name>.md`），由 Skill 版本拥有、可独立发版。

---

## 16. 用量、预算与可观测性

- **预算准入**：每次模型请求前 `UsageLedger.reserve()`，检查用户/平台日/月 Token 与成本上限；请求结束后 `settle()` 用实际用量修正；预留不会因失败而丢失。
- 计数器 `personal_usage_counters` 提交估算、结算增量，近似但收敛；`GET /api/v1/usage` 返回明细与告警比例。
- **可观测性**：
  - `/health`、`/health/live`、`/health/ready`（DB 就绪）；
  - Worker 心跳写 `personal_worker_health`，管理端可查；
  - 指标/告警：`telemetry`（计数、耗时、错误、上下文），可接外部采集；
  - 审计支持按天保留（`AUDIT_RETENTION_DAYS`）批量清理；事件日志默认不自动删除（回放依赖）。

---

## 17. 部署与运行要点

```bash
# 生产
DATABASE_URL=postgres://... \
HARNESS_MODE=production \
E2B_TEMPLATE=... SANDBOX_PROVIDER=aliyun-e2b \
OSS_BUCKET=... OSS_ENDPOINT=... OSS_EXECUTION_ROLE_ARN=... \
node dist/src/main.js          # API
node dist/src/worker-main.js   # Worker（可多副本）

npm run migrate:prod           # 迁移（SCHEMA_VERSION=18）
npm run config:import:prod     # 发布 Agent 配置
npm run skills:deliver         # 同步只读 Skill 树
```

关键环境变量：

| 组 | 变量 |
| --- | --- |
| 运行 | `HARNESS_MODE`、`DATABASE_URL`、`PORT/HOST`、`INLINE_WORKER`、`WORKER_CONCURRENCY`、`CONFIG_DIR` |
| 认证 | `UCS_JWKS_URL/UCS_ISSUER/UCS_AUDIENCE`、`DEV_TOKEN/DEV_SUBJECT`、`UCS_ADMIN_USER_IDS` |
| 模型 | `LLM_BASE_URL/PROVIDER/MODEL_ID/API_KEY`（目录为空时的回退）、`LLM_*` 限额 |
| 沙箱 | `SANDBOX_PROVIDER`、`E2B_TEMPLATE/CUBE_TEMPLATE_ID`、`SANDBOX_*`、`SANDBOX_NETWORK_*`、`SANDBOX_MULTI_SESSION` |
| 存储 | `WORKSPACE_STORAGE_KIND`、`WORKSPACE_MOUNT_DIR`、`WORKSPACE_HOST_ROOT`、`OSS_*` |
| Skill | `SANDBOX_SKILLS_ROOT`、`SKILL_MOUNT_JSON`、`SKILL_DELIVER_DIR`、`SKILL_ARCHIVE_*` |
| 定时任务 | `SCHEDULES_ENABLED`、`SCHEDULE_MAX_ACTIVE`、`SCHEDULE_INTERACTIVE_RESERVE`、`SCHEDULE_*` |
| 预算 | `USAGE_POLICY_JSON`、`RUN_TOKEN_KEY`、`CONFIG_SECRET_KEY` |

Dockerfile 为两阶段构建（Node 24 bookworm-slim），产物在 `dist/`，迁移文件随镜像发布；`compose.demo.yml` 提供 Postgres + demo API 的最小演示。

---

## 18. 关键不变量与设计取舍（速记）

1. **数据库是唯一事实源**：API/Worker 无内存共享；所有互斥、游标、发布都靠 SQL 事务/唯一约束。
2. **Run 的语义在提交时冻结**：版本、摘要、模型、能力快照、cwd、任务链身份都不会被部署变更改写。
3. **不确定即失败**：工具结果未知、沙箱写者未知、租约丢失都按失败/隔离处理，绝不乐观重试。
4. **审批是 UX，不是安全边界**：真正的边界是平台策略 + 沙箱路径/网络 + Provider 防火墙；审批卡只决定“是否跳过人工确认”。
5. **沙箱计算可替换，用户数据不可替换**：工作区身份与实例生命周期完全解耦。
6. **事件日志即历史**：SSE 只是投递方式，断线重连、审计、Fork 都依赖持久事件与 transcript。
7. **UI 无关**：客户端只需 HTTP/SSE；Web/桌面/移动/IM 都可以复用同一契约。

---

## 附录 A：API 速查（均在 `/api/v1` 下）

| 组 | 路径 |
| --- | --- |
| Agent | `GET /agents`、`GET /agents/:key`、`GET /agents/:key/commands` |
| Session | `POST/GET /sessions`、`GET/PATCH/DELETE /sessions/:id`、`POST /sessions/:id/fork`、`POST /sessions/:id/runs` |
| Run | `GET /runs/:id`、`POST /runs/:id/cancel`、`GET /runs/:id/events`（SSE） |
| Interaction | `POST /interactions/:id/response` |
| 文件/沙箱/记忆 | `GET/PUT/DELETE /me/files*`、`GET /me/sandbox`、`POST /me/sandbox/{resume,release}`、`GET/PATCH/PUT/DELETE /me/memory*` |
| 定时任务 | `GET/POST /schedules`、`GET/PATCH/DELETE /schedules/:id`、`POST /schedules/:id/run`、`GET /schedules/:id/runs`、`POST /schedules/preview` |
| 管理 | `GET/POST /admin/config/*`、`GET/POST /admin/skills*`、`GET /admin/audit`、`GET /admin/metrics`、`GET /admin/stats`、`GET /admin/usage`、`GET /admin/health/workers` |

## 附录 B：目录结构（运行时）

```text
/workspace/                      # 用户持久工作区
├── projects/                    # Session 的 cwd 通常在此
├── documents/
├── outputs/
├── memory/                      # 用户级记忆
└── .personal-agent/workspace-version   # 归属哨兵，每次挂载校验
```
