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
- PostgreSQL 事务持久化、同 Session 单写 Run、幂等冲突检测、独立 Worker、心跳和租约；故障中的不确定操作以 FAILED 结束，禁止自动重放。
- 持久事件日志、SSE 回放和心跳；断连不取消 Run；取消、问答、审批和 Todo。
- 真正调用 Pi SDK，受控 ResourceLoader，无本地资源自动发现；只暴露 `remote_*` 和构建期工具，关闭默认工具/动态 Extensions/Codemode。
- CubeSandbox 独立工作区 Volume、`/skills` RO、`/workspace` RW；按需启动、连接、重建、暂停、销毁；工作区工具执行互斥。
- Remote read/write/edit/bash/ls/grep/find：非 root、路径与符号链接限制、原子替换、SHA-256 编辑冲突检测、扫描与输出限制、远程命令超时。
- 真实 Streamable HTTP MCP Client：部署配置中的 HTTPS Endpoint、工具白名单、调用前撤销检查、服务凭证与审批。
- 独立 Session 子 Agent；能力交集、相同 Skill Bundle、深度/数量/共享步骤与 Token 预算、级联取消。
- 请求 ID、Run/Session/Tool 事件关联、元数据审计和租户运行统计。

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

LLM Gateway 当前采用 OpenAI Chat Completions 兼容协议，部署配置中的 `LLM_PROVIDER` / `LLM_MODEL_ID` 构成模型白名单；模型单次输出上限 4096。Token 预算按返回 usage 累计，是响应后检查的预算；单次响应可能超额，不是精确的预付费额度。

Cube Template 必须预装 Python 3 / Bash，存在无 sudo 的执行用户，对其授予 Workspace 写权限；持久 Volume 后端、非特权配置、磁盘/CPU/内存和网络出口限制由 Cube 集群配置。Harness 不向 Sandbox 注入 UCS、模型或 MCP 凭证。Skills 发布者负责不可变 Volume；登记的 SKILL.md 在显式读取时校验 SHA-256。

Cube Node SDK 的 npm 包在开发时返回 404，已从官方固定 commit 构建并随工程打包。来源、构建方法和许可证见 [vendor/README.md](vendor/README.md)。不存在运行时安装 SDK 的逻辑。Pi 仍为 0.99.2；官方包仅重打包更新 shrinkwrap 中的 brace-expansion 依赖，SDK 源码未修改。Fastify / MCP SDK 锁定修复后的 5.12.5 / 1.32.1；详细来源与复现步骤同见 vendor/README.md。

受限代理环境中，按所在平台配置 Node 的代理与 CA（例如 Node 24 的 `NODE_USE_ENV_PROXY=1`、`NODE_EXTRA_CA_CERTS`）。Docker 构建可传入 `--secret id=proxy_ca,src=...`；无需关闭 TLS 验证。

## 验证

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
- 不含生产备份恢复、自动闲置回收、完整孤儿 Sandbox 对账、分布式追踪、费用结算和租户容量配额。Session 分支/显式迁移 API 尚未提供。

API 协议和配置示例见 [docs/api.md](docs/api.md)。

## 真实 DeepSeek 测试

支持 Pi 内置 `deepseek` provider / `deepseek-flash`；使用其原生 Endpoint 时保留 Pi 的 reasoning / compatibility 配置，不重新登记为通用模型。

```bash
npm run build
# 使用环境的 Secret 配置注入 DEEPSEEK_API_KEY，或通过 --key-stdin 输入。
NODE_USE_ENV_PROXY=1 npm run test:deepseek
```

该测试调用真实 DeepSeek 模型，验证 REST/SSE、幂等键、模型调用受控 read 工具、重建 Worker/Pi Session 后的历史恢复。文件工具使用内存测试夹具，不能据此声称真实 CubeSandbox 验收通过。脚本不会将密钥写入文件；仅保存无密钥结果到 `work/deepseek-live-result.json`。网络预检被拦截时不发送密钥、不冒充测试通过。单 Run 最长 120 秒，最多 12 步，单次模型输出上限 4096 tokens。
