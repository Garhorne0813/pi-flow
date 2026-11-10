# Personal Agent Platform 改造说明

本说明对应当前代码，可直接运行。[implementation_doc.md](implementation_doc.md) 是当前简化设计。配置由数据库中的可编辑 Agent 管理，Run 保存最小执行快照；不再要求 Git 发布或 Agent 版本库。阿里云 E2B / OSS、多会话租约等能力仍未实现。

## 运行

需要 Node.js 24 或以上。

```sh
npm ci
npm run check
npm run build
HARNESS_MODE=demo DEV_TOKEN=replace-with-a-long-random-token npm start
```

Demo 不需要数据库、模型服务或本地 shell 执行权限。Agent 使用内建示例，启动不读取 `config/`。文件保存在内存中。释放沙箱保留文件，重启 demo 进程则丢失内存数据。

生产运行当前支持 Cube 持久卷；配置见 `.env.example`。先停止旧 API/Worker 并执行数据库迁移，再分别启动新 API 和 Worker；Agent 可直接通过管理 API 创建：

```sh
npm run migrate:prod
npm start
# 另一个进程，使用相同数据库和配置密钥
npm run worker
```

个人 schema 版本为 **6**；迁移文件顺序为 `005_agent_task_versions.sql`、`006_logical_agent_acl.sql`、`007_personal_platform.sql`、`008_editable_agents.sql`、`009_personal_execution_indexes.sql`，两个 schema 独立管理。v6 将已有个人平台的 active Agent 转为当前可编辑配置，并保留旧 Run 快照和等待交互任务；旧版本表仅作历史档案。`harness_*` 表不自动迁移、不重命名，也不推断旧工作区的数据归属。应备份数据库后在部署窗口执行迁移。

## 当前契约

- 身份按 `(issuer, subject)` 解析为持久 UUID；用户数据按 UUID 分区。OIDC 个人模式不要求 tenant claim。DEV_TOKEN 支持 `DEV_SUBJECT`，COP 使用 `UCS_VERIFY_URL`。
- 每人一个私有 `/workspace`、一个持久卷和一个沙箱绑定；不同会话可使用不同 cwd，但同一用户的 Run 串行执行。旧 workspace/members HTTP 接口不开放。
- `POST /api/v1/sessions {agentId, cwd?, title?}`；`GET /sessions`；`GET/PATCH/DELETE /sessions/:id`；`POST /sessions/:id/fork`。删除为软删除且要求会话空闲。
- 原有 Run、审批/提问续跑、取消、SSE 契约保留。根 Run 提交时保存有效配置、模型、cwd、taskId/rootRunId；下一根 Run 读取当前 Agent 配置，续跑继承原快照。Session 不再保存或升级 Agent 版本。
- `GET /me/files?path=...&operation=ls|read`、`PUT /me/files {path,content}`、`DELETE /me/files?path=...`。文件操作复用个人沙箱；Run 执行期间返回冲突。
- `GET /me/sandbox`；`POST /me/sandbox/resume`、`/release`。release 不删除卷。
- `GET /me/memory`、`GET/PUT /me/memory/:name`，支持 `scope=user|project&cwd=...`。模型启用 memory 后只注入索引，主题写入重建索引并受配额限制。
- `SCHEDULES_ENABLED=true` 开启 `/schedules` 的创建、列表、查询、更新、删除、手动触发、运行历史及 cron 预览。严格五段 cron；触发与 Run 创建同事务；无人值守不产生交互。
- 工具增加 `web_search` / `web_fetch`。Web 请求在控制面执行，拒绝私网地址，DNS 结果固定到连接并逐次验证重定向；搜索需配置 `WEB_SEARCH_URL`（通过 `q` 参数调用搜索服务）。

## 当前配置与可选导入

`personal_agents` 保存可编辑的 Agent，id 对应稳定 key；每次编辑原地更新，无需发布新版本。`GET /api/v1/agents` 和 `/agents/:key` 直接返回当前 `{id,config,enabled,allowedUsers,updatedAt}`，不再返回 activeVersionId 或 version 包装。

`AgentConfig` 支持 `model: default`（创建 Run 时解析当前默认模型）、固定 `{provider,modelId}`、`systemPrompt/agentsMd` 及内联 `subagentDefinitions`。子 Agent 的工具、Skill、MCP、审批、记忆和 Token 访问能力受父级限制，且不能再次委派。

目录只是可选导入格式：`npm run config:import -- --check` 可离线校验；`CONFIG_DIR=/path/to/config npm run config:import` 可初始化空数据库。已有 Agent 时导入返回 `CONFIG_ALREADY_INITIALIZED`，只有显式 `--replace` 才覆盖当前清单。无需 Git 仓库、自动同步或单独的发布流程。

目录导入器可将 HOUSE.md、SYSTEM.md、AGENTS.md 和 subagents 文件合并为普通 AgentConfig；运行时只使用数据库中的结果。Demo 仅在清单为空时创建内建示例，重启不会覆盖已有配置。生产镜像不必携带配置目录；如要使用目录导入 CLI，需自行挂载并指定 CONFIG_DIR。

`config/skills/<id>/SKILL.md` 及辅助文件按内容归档；拒绝符号链接，限制文件数和总大小；支持 `disable-model-invocation` 和 `agents/<name>.md`。`npm run skills:deliver` 将版本原子物化到 `SKILL_DELIVER_DIR`。Cube 支持通过 `SKILL_VOLUMES_JSON` 配置只读卷或受 `SKILL_HOST_ROOTS_JSON` 限制的 hostPath。ZIP 上传通过 `SKILL_UPLOAD_ROOT` 原子写入 hostPath，并由 Provider 只读挂载；目录物化本身不等于 Provider 已挂载。MCP 注册可放入 `config/mcp/servers.yaml`，格式为 `{id,endpointRef,allowedTools,enabled}` 数组；endpointRef 必须对应 Worker 的 `MCP_ENDPOINTS_JSON`。

`/admin/ui` 管理控制台支持个人 Agent 的原地编辑、访问权限、禁用、Skill/MCP 登记和 ZIP 上传。保存 Agent 使用整份清单的 revision 防止并发覆盖，并保留编辑器尚未支持的配置字段；排队和审批续跑任务继续使用原快照。管理配置与 Skill/MCP 写入平台 registry，对所有个人身份一致生效。旧共享引擎保留逻辑版本和 ACL 行为，个人运行不创建或升级 AgentVersion。

管理接口：

- `GET/POST /admin/config/agents`：POST 接受 `{revision,agents:[{key,config}]}`，整份校验后原子更新；允许空数组，省略的 Agent 被禁用。可传入 enabled/allowedUsers；不创建 AgentVersion 或 publication。
- `GET/POST /admin/config/global`：POST 接受 `{revision,policy:{disabledTools},modelCatalog?,secrets?}`。两个作用域有独立 revision，不匹配返回 409。revision 仅用于防止并发编辑覆盖；全局编辑不会修改 Agent 的 revision，不维护发布或草稿状态。
- `modelCatalog` 条目为 `{provider,modelId,baseUrl,secretRef,default}`，非空目录要求唯一默认模型。`secrets` 为引用名到密钥的映射，使用 `CONFIG_SECRET_KEY` 加密，GET 不返回密钥。目录非空时只允许目录中的模型；目录为空才回退 `LLM_*`。每个模型会话有独立凭证上下文。Run 通过私有 `modelGatewayRef` 固定网关与加密密钥版本；目录替换和同名密钥轮换不改变已排队任务或审批续跑。
- `approval.mode=user|guarded|auto`；默认 user。guarded 当前仅对精确 `pwd` shell 命令自动放行。平台 disabledTools 对旧 Run 也生效。
- `userTokenAccess=true` 时提交 Bearer 以 `RUN_TOKEN_KEY` 密封，只有 bash 获得 `USER_TOKEN`，终态移除密文。两个加密密钥都应为 base64 编码的 32 随机字节，并在 API/Worker 之间保持一致。

COP 适配器当前接受成功响应 `{code:200|0,data:{userId|id,roleKeys?}}` 或 `success:true`；使用 GET 和 `Token` 头，提供正/负缓存、并发合并、熔断。部署前须与真实 COP 响应契约核对；本地协议测试不代表已完成线上联调。

## 尚需完成的目标能力

以下为明确未覆盖的目标，不应作为当前部署承诺：

1. 阿里云 E2B / OSS、工作区 hostPath 存储、多会话租约、Provider 网络防火墙和模板全局覆盖。当前只支持 Cube / demo、持久卷 / memory；不支持的 provider、网络模式和多会话设置会在启动时拒绝。
2. 完整规范化的数据模型及横跨所有用户的原子平台预算。当前 Run/Session/Event/Skill/配置/定时任务已有独立表；工作区绑定、审计、记忆计数及部分调度元数据仍使用用户状态文档。已有预算按用户分区执行，不能当作跨用户全局预算。
3. 旧共享工作区配置的专门迁移工具、Skill 交付回滚与生产对账。Agent 草稿、发布历史与 Git 自动同步不属于当前设计。
4. 调度的 jitter、misfire 策略、结束条件、全局交互容量预留；记忆的定期去重/归档/索引修复和完整删除/批量管理 API。
5. 图片输入契约、200 ms transcript 合并 checkpoint，以及独立的用户/会话 fencing 租约表。当前保留已有 operation ownership、未知结果隔离和 Run lease 故障语义。

评审修复、迁移和性能验证详见 [PR #60 评审修复](pr60-review-fixes.md)。

## 验证

```sh
npm run check
npm run build
npm run smoke
TEST_DATABASE_URL=postgres://... REQUIRE_POSTGRES_TESTS=true npm test
```

新增测试覆盖当前配置更新、并发编辑冲突、排队 Run 快照、审批续跑、实时禁用和访问控制；目录导入防止无意覆盖；v5→v6 数据库迁移验证旧等待交互任务、Session 转换和重复迁移不覆盖新配置。原有私有工作区、MCP、记忆、调度、Token、Skill 交付与 SSE 测试继续运行。

CI 依赖审计使用 `npm audit --audit-level=high`。已升级 Fastify、Zod、body-parser 和两条 Undici 依赖链；Pi SDK 仅重打包安全依赖元数据，源码和 dist 保持不变。仍有 2 项与 Pi/minimatch 相关的中危报告，不阻塞当前审计门槛。

与 main 整合后的验证：285 项测试全部通过，0 失败、0 跳过，包含真实 PostgreSQL、v5→v6 迁移和回滚、个人与旧版控制台浏览器测试、Skill ZIP 上传。类型检查、构建、无配置目录 Demo 冒烟、可选目录导入校验与 vendored SDK 校验通过。最终 UI 文案调整后另跑 20 项控制台测试和 Demo 冒烟，均通过。后续 CI 安全依赖修复将审计结果降为 2 moderate、0 high、0 critical，`npm audit --audit-level=high` 通过。
