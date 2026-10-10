# Deployment / 部署与联调

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Architecture](architecture.md) · [中文架构](architecture.zh-CN.md)

## Production startup / 生产启动

Copy `.env.example` to `.env` and configure PostgreSQL, the model gateway, CubeSandbox, and authentication. Production validates required configuration and refuses startup rather than falling back to Demo. API and every Worker must share database, tenant grants, model settings, skill mappings, MCP endpoints, capacity policy, and usage pricing.

复制 `.env.example` 为 `.env`，配置 PostgreSQL、模型网关、CubeSandbox 和认证。生产配置缺失时拒绝启动，不回退到 Demo。API 与全部 Worker 必须使用相同数据库、租户授权、模型、技能映射、MCP Endpoint、容量策略与用量价格。

```bash
cp .env.example .env
npm ci
npm run build
node --env-file=.env dist/migrate.js
node --env-file=.env dist/main.js
# Separate terminal / 独立终端
node --env-file=.env dist/worker-main.js
```

Publish an agent through `/api/v1/admin/agents` before creating a production session. The Demo seed is not created in production. Payload examples are in [API](api.md).

生产环境先通过 `/api/v1/admin/agents` 发布智能体，再创建会话；不会自动创建 Demo 智能体。配置示例见 [API 文档](api.md)。

## Identity and model / 身份与模型

UCS OIDC tokens need `sub`, `tenant_id`, and `exp`; administrators need `harness-admin` in `roles`. Offline JWT verification does not provide central immediate revocation or enterprise group mapping; integrate introspection/revocation events where required. Ticket authentication is not implemented.

UCS OIDC 令牌需含 `sub`、`tenant_id`、`exp`，管理员 `roles` 需包含 `harness-admin`。离线验签不提供中央即时撤销或企业用户组映射，有此要求的部署需接 introspection/撤销事件。Ticket 认证尚未实现。

Isolated integration environments may explicitly set a `DEV_TOKEN` of at least 16 characters, plus `DEV_TENANT_ID` / `DEV_USER_ID`. This identity always has admin access and emits `auth_fixed_token_enabled`; remove it before exposing the service to untrusted clients. The model gateway defaults to HTTPS; isolated HTTP requires `LLM_ALLOW_HTTP=true`.

封闭联调环境可显式设置至少 16 字符的 `DEV_TOKEN`，以及 `DEV_TENANT_ID` / `DEV_USER_ID`。固定身份始终有管理员权限，启动产生 `auth_fixed_token_enabled` 告警；对外开放前移除并配置 OIDC。模型网关默认要求 HTTPS，隔离 HTTP 网关需显式设置 `LLM_ALLOW_HTTP=true`。

`LLM_PROVIDER` / `LLM_MODEL_ID` define the approved gateway model. Gateway requests use OpenAI Chat Completions compatibility. Model output is capped at 4096 tokens and further constrained by budgets. `USAGE_POLICY_JSON` defines shared token/cost budgets and versioned prices; estimates are not provider invoices. See [usage budgets](usage-budgets.md).

`LLM_PROVIDER` / `LLM_MODEL_ID` 定义获批网关模型，使用 OpenAI Chat Completions 兼容协议。单次输出上限 4096 tokens，并受预算进一步约束。`USAGE_POLICY_JSON` 定义共享 Token/费用预算和版本化价格；估算不等于供应商账单。详见 [用量预算](usage-budgets.md)。

## Sandbox, skills, and MCP / 执行环境、技能与 MCP

Cube templates need Python 3, Bash, a non-root execution user without passwordless sudo, and workspace write access. Keep `/skills` empty without preinstalled/shared skills or extra skill mounts. Cube infrastructure must enforce storage durability, resource limits, and outbound network policy. `allowPublicTraffic=false` limits inbound access and does not establish outbound isolation. Validate these properties in the target cluster; see [integration findings](local-deployment.md).

Cube 模板需预装 Python 3、Bash，使用非 root 且无免密 sudo 的执行用户，并授予工作区写权限。模板 `/skills` 应为空，无预置共享技能或额外技能挂载。持久存储、资源限制和出口网络策略由 Cube 基础设施强制执行。`allowPublicTraffic=false` 限制入站访问，不代表出口隔离；需在目标集群验证，见 [联调记录](local-deployment.md)。

Each skill version uses an independent immutable volume. Its root contains that skill's `SKILL.md`, scripts, and resources. Example `SKILL_VOLUMES_JSON`:

每个技能版本使用独立不可变卷，根目录只包含该技能的 `SKILL.md`、脚本和资源。例如：

```json
{"review@v1":{"bundle":"default","path":"/skills/review/v1/SKILL.md","volume":"skill-review-v1"}}
```

Register matching metadata through the admin API, then select `review@v1` in the agent's `skills`. Only selected volumes mount read-only. `SKILL_BUNDLES_JSON` defines authorization groups, not shared mount sources. Publishers must preserve volume immutability; manifest hashing cannot replace storage enforcement.

通过管理 API 登记一致的元数据，再在智能体 `skills` 中选择 `review@v1`。仅选定卷只读挂载。`SKILL_BUNDLES_JSON` 是授权分组，不是共享挂载源。发布者需保证卷不可变，清单哈希不能代替存储层约束。

`MCP_ENDPOINTS_JSON` defines HTTPS service endpoints and optional credential environment references. Register an endpoint reference and tool allowlist through the admin API. `TENANT_CAPABILITIES_JSON` explicitly limits each tenant's bundle/endpoint references. Give confidential skills and service credentials separate references across tenants. MCP currently uses service credentials; delegated OAuth and Vault/KMS integration are pending.

`MCP_ENDPOINTS_JSON` 配置 HTTPS Endpoint 和可选凭证环境变量引用，管理 API 登记 Endpoint 引用与工具白名单。`TENANT_CAPABILITIES_JSON` 显式限定各租户可用 Bundle/Endpoint。不同租户的机密技能和服务凭证使用独立引用。MCP 当前使用服务凭证，用户委托 OAuth 和 Vault/KMS 接入待实现。

## Lifecycle and upgrades / 生命周期与升级

Capacity and idle settings are listed in `.env.example`. Active, reserved, and unknown operations count toward quotas; paused instances do not. Workers scan for idle pause/release. Instance snapshots do not back up persistent volumes or conversation history; configure independent database and volume backups. Cube cross-workspace snapshot cloning is unsupported.

容量与空闲配置见 `.env.example`。active、reserved、unknown 占用配额，暂停实例不计入。Worker 扫描空闲实例并暂停/释放。实例快照不备份持久卷或对话历史，应独立配置数据库与卷备份；Cube 不支持跨工作区快照克隆。

For an existing deployment, stop all old API/Workers, back up, apply migrations 001–004, and upgrade together. Do not mix JSONB-era writers with normalized table writers. Review [Run migration and rollback](run-migration.md) and [capacity migration](capacity-migration.md). Readiness/schema checks are described in [health](health.md).

已有部署应先停止全部旧 API/Worker、备份，再执行 001–004 迁移并统一升级；禁止旧 JSONB 写入者与独立表写入者混跑。详见 [Run 迁移与回滚](run-migration.md)、[容量迁移](capacity-migration.md) 和 [健康检查](health.md)。

## Live-model checks / 真实模型测试

Build first and inject keys through the environment or `--key-stdin`. The scripts use in-memory file/store fixtures; they do not establish real Cube or PostgreSQL production acceptance.

先构建，再通过环境或 `--key-stdin` 注入密钥。脚本使用内存文件/Store 夹具，不能代表真实 Cube 或 PostgreSQL 生产验收。

```bash
npm run build
# DEEPSEEK_API_KEY supplied by the environment / 由环境提供密钥
NODE_USE_ENV_PROXY=1 npm run test:deepseek
NODE_USE_ENV_PROXY=1 npm run test:deepseek:capabilities
```

The first script covers REST/SSE, idempotency, controlled reads, and restored Pi history. The capabilities script covers Todo, questions, skills, child tasks, and a local HTTPS MCP server; it requires `openssl`. Results are written to `work/deepseek-live-result.json` and `work/deepseek-capabilities-result.json`. Capability subsets can be rerun with `-- --only=skills` (also `todo`, `askUser`, `subagent`, `mcp`).

首个脚本验证 REST/SSE、幂等、受控读取和 Pi 历史恢复；扩展脚本验证 Todo、问答、技能、子任务和本地 HTTPS MCP 服务，需要 `openssl`。结果保存到 `work/deepseek-live-result.json` 和 `work/deepseek-capabilities-result.json`。可用 `-- --only=skills` 单项复测，也支持 `todo`、`askUser`、`subagent`、`mcp`。

OpenAI-compatible live gateways can use `SMOKE_PROVIDER`, `SMOKE_MODEL`, `SMOKE_BASE_URL`, and `SMOKE_API_KEY`. If providers match, `LLM_API_KEY` may be reused. HTTP needs the explicit opt-in:

OpenAI 兼容网关可使用 `SMOKE_PROVIDER`、`SMOKE_MODEL`、`SMOKE_BASE_URL` 和 `SMOKE_API_KEY`；Provider 相同时可复用 `LLM_API_KEY`。HTTP 需显式开启：

```bash
SMOKE_PROVIDER=glm SMOKE_MODEL=glm-5.3-flash SMOKE_BASE_URL=http://<gateway>/v1 \
LLM_ALLOW_HTTP=true node --env-file=.env scripts/smoke-deepseek.mjs
```

For restricted proxy environments, configure Node proxy/CA settings such as `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS`. Docker accepts `--secret id=proxy_ca,src=...`; retain TLS verification. SDK provenance and reproducible package builds are in [vendor/README.md](../vendor/README.md). CI, benchmarks, and remaining acceptance requirements are in [ci.md](ci.md), [read-benchmark.md](read-benchmark.md), and [acceptance.md](acceptance.md).

受限代理环境可配置 `NODE_USE_ENV_PROXY=1`、`NODE_EXTRA_CA_CERTS`；Docker 构建可传入 `--secret id=proxy_ca,src=...`，保持 TLS 校验。SDK 来源和可复现打包见 [vendor/README.md](../vendor/README.md)。CI、基准与剩余验收见 [ci.md](ci.md)、[read-benchmark.md](read-benchmark.md) 和 [acceptance.md](acceptance.md)。
