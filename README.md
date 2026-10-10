# Enterprise Agent Harness

基于附件 CubeSandbox 方案实现的 **0.1 后端首版**。TypeScript / Node.js 24 + Fastify + Pi 0.99.2 + PostgreSQL。提供 REST/SSE；不包含对话前端与长期 Memory。

## 快速运行

```bash
npm ci
npm run build
HARNESS_MODE=demo DEV_TOKEN=local-demo-token-2026 npm start
```

服务默认监听 `http://127.0.0.1:8080`。Demo 使用固定演示身份、内存状态、模拟模型和内存文件工具；**不会执行 Worker 本地 Shell，不调用真实模型或 CubeSandbox**。重启后数据丢失。

```bash
curl -H 'Authorization: Bearer local-demo-token-2026' http://127.0.0.1:8080/api/v1/agents
npm run smoke
```

`npm run smoke` 自动启动编译后的服务，使用随机令牌，验证 Workspace → Session → Run → SSE、幂等键和文件上传下载，然后关闭服务。需要空闲的本地 18081 端口。

使用 PostgreSQL 持久化元数据的 Demo（模拟 Sandbox 文件仍在内存中，重启不会保留文件）：

```bash
DEV_TOKEN=local-demo-token-2026 docker compose -f compose.demo.yml up --build
```

## 已实现

- UCS OIDC JWT 认证适配：HTTPS JWKS、签名、issuer、audience、过期与租户声明校验；禁止从请求参数指定租户。
- Tenant 隔离、Workspace owner/editor/viewer ACL、Agent 使用 ACL、管理员发布与撤销。
- 不可变 Agent 配置版本，Session 固定版本；Skills / MCP 注册和禁用；模型仅允许部署时批准的网关模型。
- PostgreSQL 只读快照/写事务分离、跨 tick 租户轮询调度、同 Session 单写 Run、幂等冲突检测、独立 Worker、心跳和租约；故障中的不确定操作以 FAILED 结束，禁止自动重放。
- 持久事件日志、SSE 回放和心跳；断连不取消 Run；取消、问答、审批和 Todo。
- 真正调用 Pi SDK，受控 ResourceLoader，无本地资源自动发现；只暴露 `remote_*` 和构建期工具，关闭默认工具/动态 Extensions/Codemode。
- CubeSandbox 独立工作区 Volume、按 Agent 授权挂载的只读技能 Volume、`/workspace` RW；按需启动、连接、重建、暂停、销毁；工作区工具执行互斥。
- Remote read/write/edit/bash/ls/grep/find：非 root、路径与符号链接限制、原子替换、SHA-256 编辑冲突检测、扫描与输出限制、远程命令超时。
- 真实 Streamable HTTP MCP Client：部署配置中的 HTTPS Endpoint、工具白名单、调用前撤销检查、服务凭证与审批；发现继承 Run 取消/剩余 deadline，总预算最多 30 秒，单 Agent 最多 16 个 Server，连接清理最多等待 250 ms。
- 独立 Session 子 Agent；能力交集、相同 Skill Bundle、深度/数量/共享步骤与 Token 预算、级联取消。
- 请求 ID、Run/Session/Tool 事件关联、元数据审计和租户运行统计。
- Sandbox 用户/全局活跃配额、跨 Worker 原子预留与持久 fencing、创建/连接期间取消清理、空闲暂停/释放、手动恢复与保留 Volume 的释放；Workspace 绑定的实例快照创建/列表/删除/恢复/克隆。

## 接入真实服务

复制 `.env.example`，填写真实服务配置。Node 24 支持 `--env-file`：

```bash
npm ci
npm run build
node --env-file=.env dist/migrate.js
node --env-file=.env dist/main.js
# 另一终端或独立部署单元
node --env-file=.env dist/worker-main.js
```

API 和 Worker 必须使用同一数据库、模型批准列表、Skills Bundle 映射和 MCP Endpoint 配置。生产模式还必须配置 `TENANT_CAPABILITIES_JSON`，明确每个租户可用的 Bundle / Endpoint 引用；不同租户的机密技能和服务凭证应配置为不同引用。生产模式缺少关键配置时直接拒绝启动，不会退回 Demo。UCS 令牌需包含 `sub`、`tenant_id`、`exp`；管理员 `roles` 包含 `harness-admin`。Ticket 协议尚未实现，可替换 `Auth` 适配函数。

LLM Gateway 当前采用 OpenAI Chat Completions 兼容协议，部署配置中的 `LLM_PROVIDER` / `LLM_MODEL_ID` 构成模型白名单；模型单次输出上限 4096。模型请求派发前使用共享账本预留额度并设置输出上限，可信 usage 返回后按服务端价格快照核算。验收范围是可执行预算控制与可审计成本估算；输入估算和最终供应商账单仍可能不同，不能保证单次绝不超支。详见 [用量与预算口径](docs/usage-budgets.md)。

Cube Template 必须预装 Python 3 / Bash，存在无 sudo 的执行用户，对其授予 Workspace 写权限；模板不得预置共享技能或额外技能挂载，`/skills` 应为空。持久 Volume 后端、非特权配置、磁盘/CPU/内存和网络出口限制由 Cube 集群配置。Harness 不向 Sandbox 注入 UCS、模型或 MCP 凭证。Skills 发布者负责不可变 Volume；每次远程工具执行前校验已挂载 SKILL.md 的规范路径和 SHA-256；read/grep 返回 manifest 内容前再次校验，路径别名使用同一策略。Skill Volume 必须保持不可变，bash 的执行前校验不能替代存储不可变性。

每个技能版本使用独立 Volume，其根目录只包含该技能的 `SKILL.md`、脚本和资源。部署 `SKILL_VOLUMES_JSON` 将 skill ID 绑定到 Bundle、完整 SKILL.md 路径和 Volume；例如 `{"review@v1":{"bundle":"default","path":"/skills/review/v1/SKILL.md","volume":"skill-review-v1"}}`。Agent 配置 `skills:["review@v1"]` 后，Sandbox 仅在 `/skills/review/v1` 只读挂载该 Volume，不挂载整个 Bundle。`skills:[]` 不挂载任何技能；缺少或不匹配的映射会拒绝创建，禁止回退到共享 Bundle Volume。`SKILL_BUNDLES_JSON` 保留为租户权限分组，其值不再作为挂载源。旧部署需要把 Bundle 文件拆成每技能 Volume 并配置新映射。

共享 Workspace 切换到不同技能集合时，下一次远程工具访问会先 Kill 旧 Sandbox，再按当前 Agent 权限重建，保留 `/workspace` Volume。子 Agent 使用父子权限交集，返回父 Agent 后下一次工具调用恢复父 Agent 挂载。旧实例没有技能范围标记时也强制重建；Kill 未确认成功则停止访问。文件 API 使用独立、仅挂载 Workspace 的临时实例，请求结束后确认 Kill；不改变 Agent 的实例、技能范围或空闲计时。读取可与 Agent 工具并行，写入与 Agent 工具互斥；临时实例计入 Workspace owner 和全局容量，配额满时返回 429，不会释放 Agent 实例来腾挪容量。MCP 只发现 Agent `mcpServers` 指定的 Server，子 Agent 同样取权限交集；未授权的 Server/工具在审批前拒绝，已发现的 Server 被撤销或更换 Endpoint 后也拒绝调用。租户管理员的技能/MCP 登记列表属于管理面，不暴露给模型。

Cube Node SDK 的 npm 包在开发时返回 404，已从官方固定 commit 构建并随工程打包。来源、构建方法和许可证见 [vendor/README.md](vendor/README.md)。不存在运行时安装 SDK 的逻辑。Pi 仍为 0.99.2；官方包仅重打包更新 shrinkwrap 中的 brace-expansion 依赖，SDK 源码未修改。Fastify / MCP SDK 锁定修复后的 5.12.5 / 1.32.1；详细来源与复现步骤同见 vendor/README.md。

受限代理环境中，按所在平台配置 Node 的代理与 CA（例如 Node 24 的 `NODE_USE_ENV_PROXY=1`、`NODE_EXTRA_CA_CERTS`）。Docker 构建可传入 `--secret id=proxy_ca,src=...`；无需关闭 TLS 验证。

## 验证

PR 自动执行 Node 24 质量门禁和真实 PostgreSQL 测试；开发、发布、分支保护与回滚步骤见 [docs/release.md](docs/release.md)。

```bash
npm run check
npm test
npm run build
npm run smoke
# 可选：真实 PostgreSQL 测试，不设置该变量会明确 skip 一项
TEST_DATABASE_URL=postgres://user:password@127.0.0.1:5432/testdb npm test
```

JWT/MCP 测试使用本地 HTTPS 测试服务，需要 `openssl`；远程工具契约测试使用可信测试脚本和临时工作目录，需要 `python3` / `bash`。这些测试不运行模型生成的本地代码。Pi 契约测试使用真实 0.99.2 SDK 与本地模拟模型网关。

## 首版边界

这份工程交付的是可运行、可联调的后端基线，**尚未完成真实企业环境的生产验收**。具体实现差异和未验证项目见 [docs/implementation.md](docs/implementation.md)。

- PostgreSQL 目前采用每租户一行 JSONB 的事务聚合，兼任持久队列。未依赖 Redis；大容量场景需拆分实体表、事件/审计分区、队列与租约索引。
- Agent 发布直接生成独立配置版本，尚无草稿、逻辑 Agent 分组、回滚 UI；可显式创建指定旧版本的新 Session。
- 问答和审批完成后创建新 Run；不承诺恢复未完成的 JS Promise。所有模型发起的写/编辑/Shell/MCP 调用默认审批，不开放配置绕过。
- 子 Agent 当前顺序执行，不能进入等待审批/问答；需要交互时安全失败，返回父 Agent。文件共享范围为同一 Skill Bundle。
- 文件 API 当前支持 UTF-8 小文件（最多 256 KiB）；不支持二进制、归档导入和对象存储 Artifact 下载。创建 Session 后才能使用文件 API。
- 本地 Workspace/Agent/MCP/Skill 撤销在后续操作中检查；UCS JWT 的中心化即时撤销/用户组映射需接 introspection 或企业事件。Run 会检查令牌过期。
- MCP 目前使用部署配置的服务凭证；用户委托 OAuth、Vault/KMS 与短期凭证尚未实现。
- 不含生产备份恢复、完整孤儿 Sandbox 对账、分布式追踪、费用结算和租户总容量配额。已实现按用户与全局限制活跃 Sandbox 和自动空闲回收；这些配额不等于真实集群容量验收。Session 分支/显式迁移 API 尚未提供。

API 协议和配置示例见 [docs/api.md](docs/api.md)。

SSE 在连接 JWT 的 exp 到期时关闭，并返回无 event ID 的 `stream.error`
（`AUTHENTICATION_EXPIRED`）。客户端通过 Authorization header 携带新令牌重连，
用最后收到的 Run event ID 作为 Last-Event-ID 回放；不要把令牌放进 URL。
每轮读取仍检查 Workspace ACL。离线 JWKS 验签只保证签名/到期检查，
不提供 UCS 中央即时撤销；需要该保证的部署应接入企业 introspection/撤销事件。

## Sandbox 容量与生命周期

默认每个租户内的用户（Workspace owner）最多 3 个活跃 Sandbox，整个 Harness 部署最多 100 个；协作者操作同一 Workspace 仍计入 owner 配额。创建/恢复/克隆先在共享数据库中原子预留容量，运行中、预留中和结果不确定的操作均计数，暂停实例不计数。配额覆盖同一数据库管理的实例，不包含 Cube 集群上其他应用创建的实例。`WORKER_CONCURRENCY` 仍只限制 Run 并发，不是 Sandbox 数量。API 与所有 Worker 必须使用相同配额和生命周期配置。

默认空闲 900 秒暂停，累计空闲 86400 秒释放实例并保留 Workspace Volume、Session 和快照记录；每 60 秒由运行中的 Worker 扫描，实际执行时间可能延后一轮或远程调用耗时。空闲从最后一次成功激活/工具调用结束计算；有 QUEUED/RUNNING Run 或工具租约的工作区会跳过，WAITING_INPUT 不阻止空闲回收。下一次工具访问自动恢复或重建，并重新检查配额。仅部署 API 而不运行 Worker 时不会自动扫描。没有历史访问时间的旧实例从首次扫描开始计时。

配置项：`SANDBOX_MAX_ACTIVE_PER_USER`、`SANDBOX_MAX_ACTIVE_TOTAL`、`SANDBOX_IDLE_PAUSE_SECONDS`、`SANDBOX_IDLE_RELEASE_SECONDS`、`SANDBOX_SWEEP_INTERVAL_SECONDS`、`SANDBOX_MAX_SNAPSHOTS_PER_WORKSPACE`（默认 20）。均为正整数；释放阈值不能小于暂停阈值。变更已有部署前，执行 `npm run migrate` 创建新的 `harness_sandbox_capacity` 表，并停掉旧版 Worker 后统一升级。启动时登记旧实例，已存在的超额实例不强制销毁，但停止新增/恢复，直到有容量。

REST 提供容量/状态查询、暂停/恢复/释放，以及快照创建/列表/删除/恢复/克隆。快照管理要求 Workspace editor/owner，并拒绝有未结束 Run 的工作区；viewer 可查看自身可访问工作区的状态和快照目录。恢复按快照创建时的技能范围检查当前注册状态与部署映射，在销毁旧实例后通过快照模板创建新实例，使用快照里记录的 Volume 挂载和 Harness 的网络设置。技能撤销或映射变更时拒绝恢复；禁止任意传入外部 Snapshot ID。Demo 克隆创建当前用户拥有的新 Workspace，使用独立的新 Volume，也受配额限制；Cube 当前拒绝跨 Workspace 克隆，避免继承源卷。

实例快照的实际内存/文件系统语义取决于 Cube 后端，Harness 不把它当作持久 Volume 的备份：恢复保留当前 `/workspace` 文件，不回滚这些文件、数据库或对话历史；Demo 克隆得到独立的空 Workspace Volume，不复制原 Workspace 文件。生产数据备份需另行配置 Volume 存储后端的备份方案。Demo 快照模拟元数据与生命周期，不能替代真实 Cube 快照验收。

远程创建/销毁结果不确定时保留容量预留，不按计时盲目释放，也不自动重试创建。管理员可在容量查询中看到本租户的 reserved/unknown 条目；已有明确 Sandbox ID 时可通过释放接口确认 Kill 后回收配额。创建请求丢失且没有 ID、或进程在记录 ID 前崩溃时，需要按 Cube metadata 与数据库做运维对账；完整自动孤儿对账仍未实现。已释放记录保留不计数的标记，避免并发启动时把已清理的旧实例再次登记。

## 真实 DeepSeek 测试

支持 Pi 内置 `deepseek` provider / `deepseek-flash`；使用其原生 Endpoint 时保留 Pi 的 reasoning / compatibility 配置，不重新登记为通用模型。

```bash
npm run build
# 使用环境的 Secret 配置注入 DEEPSEEK_API_KEY，或通过 --key-stdin 输入。
NODE_USE_ENV_PROXY=1 npm run test:deepseek
```

该测试调用真实 DeepSeek 模型，验证 REST/SSE、幂等键、模型调用受控 read 工具、重建 Worker/Pi Session 后的历史恢复。文件工具使用内存测试夹具，不能据此声称真实 CubeSandbox 验收通过。脚本不会将密钥写入文件；仅保存无密钥结果到 `work/deepseek-live-result.json`。网络预检被拦截时不发送密钥、不冒充测试通过。单 Run 最长 120 秒，最多 12 步，单次模型输出上限 4096 tokens。

扩展能力测试（同样使用 Pi 内置 provider 和真实 DeepSeek）：

```bash
npm run build
NODE_USE_ENV_PROXY=1 npm run test:deepseek:capabilities
# 也支持 -- --key-stdin；密钥从标准输入读取，不写入文件。
```

覆盖 Todo 创建/状态更新和 Session API 持久状态、ask_user_question 等待输入/Worker 重建/回答恢复与响应幂等、Skill 注册/显式远程读取/SHA-256 校验/摘要错误与撤销、子 Agent 独立 Session/权限交集/子任务 Todo/结果回传，以及本地真实 HTTPS Streamable HTTP MCP Server 的发现/审批/执行一次/拒绝无副作用/白名单/撤销。用户回答和审批决定由测试驱动器模拟；文件和只读 `/skills` 使用内存夹具，Store 也是内存实现，不代表真实 CubeSandbox 或数据库持久化验收。结果写入 `work/deepseek-capabilities-result.json`。每个 Run 最长 120 秒、最多 30 步、30,000 tokens；单次模型输出上限 4096 tokens。需要 `openssl`。测试失败后可加 `-- --only=skills`（或 `todo`、`askUser`、`subagent`、`mcp`）复测一项并合并先前结果，报告明确记录复测。

## 只读轮询负载对比

`npm run bench:store:reads` 在已迁移的 `TEST_DATABASE_URL` 测试库上，对比旧 SSE 写事务路径与新只读路径。创建并清理专用租户，模拟 100 个 250 ms 事件轮询与 4 个 1 s Run 心跳；不连接模型或 Sandbox。参数与实测结果见 [docs/read-benchmark.md](docs/read-benchmark.md)。SSE/列表查询不锁定或写回租户行；每个请求结束时仍保留一次审计写入。

容量 `operation` 是每次操作生成的唯一持久标识，激活后也保留；预留与接管原子比较前一条记录，暂停/释放/未知结果只更新匹配的标识。过期请求不能覆盖新请求的配额，普通 Agent 实例、文件实例和生命周期操作使用同一规则。取消在创建/连接/激活各阶段检查：已知实例确认 Kill 后退还配额；无 ID 的创建未知结果或 Kill 未确认继续占用，Workspace Volume 保留。升级时须同时更新并重启 API 与所有 Worker，避免与旧版不校验 fencing 的写入者混跑；现有 JSONB 状态兼容，无额外迁移。

## Cube 实例授权与快照限制

Cube 创建时的 trafficAccessToken 随实例记录持久化，执行时复用，实例清除时删除。缺少 Token 的旧实例在租约内重建并保留工作区卷。快照恢复使用模板记录的挂载；Cube 快照继承源卷，当前拒绝跨 Workspace 克隆（SNAPSHOT_CLONE_UNSUPPORTED），避免共享源工作区数据。Demo 克隆仍使用独立卷。

健康检查、Worker 心跳和 Kubernetes probes 见 [docs/health.md](docs/health.md)。

## CI quality checks

See [docs/ci.md](docs/ci.md) for required checks, mandatory PostgreSQL regressions, fault/load scenarios and retained reports.
