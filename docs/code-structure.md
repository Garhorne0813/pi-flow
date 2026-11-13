> 管理前端已迁移至 `web/src/admin/`；旧 `/admin/ui` 和 `/admin/agents/ui` 仅跳转到 `/admin/agents`。构建和当前功能见 [管理中心](admin-console.zh-CN.md)。

# 代码结构与模块边界

[README](../README.zh-CN.md) · [Architecture](architecture.md) · [架构](architecture.zh-CN.md)

## 目录导航

`src/` 根目录只保留三个进程入口，具体功能放在各自的模块目录中。

```text
src/
├── main.ts                    # API 进程入口
├── worker-main.ts             # 独立 Worker 进程入口
├── migrate.ts                 # 数据库迁移入口
├── app/
│   └── bootstrap.ts           # 部署配置、依赖装配、Demo 初始化
├── api/
│   ├── server.ts              # Fastify 创建、认证 Hook、错误处理、审计、路由装配
│   ├── auth.ts                # UCS OIDC / 开发身份认证
│   ├── context.ts             # 路由依赖类型
│   ├── validation.ts          # 共用 UUID、分页、路径参数校验
│   ├── personal.ts            # 个人工作区、可编辑 Agent、调度与文件接口
│   ├── configuration.ts       # 管理页面外壳、部署能力、租户默认配置
│   ├── agents.ts              # Agent 查询、版本发布、激活、状态与访问控制
│   ├── skills.ts              # Skill 注册、ZIP 上传、状态管理
│   ├── mcp.ts                 # MCP 注册、状态、连接检查
│   ├── operations.ts          # 健康、Worker、用量、指标、审计、统计
│   ├── workspaces.ts          # 工作区 CRUD 与成员权限
│   ├── sandboxes.ts           # Sandbox 生命周期、容量、快照
│   ├── sessions.ts            # 会话创建、列表、历史与 Todos
│   ├── runs.ts                # 提交、查询、取消 Run 与交互续跑
│   ├── events.ts              # SSE 回放、游标、背压、过期与断开清理
│   └── files.ts               # 工作区文件列表、上传、读取
├── domain/
│   ├── model.ts               # 领域类型、校验、ACL、审计与状态辅助函数
│   ├── service.ts             # Agent、工作区、会话、任务与交互业务规则
│   ├── personal-service.ts    # 个人工作区与可编辑 Agent 业务服务
│   └── usage.ts               # 用量账本、预算策略、费用估算与报告
├── storage/
│   ├── store.ts               # Store 接口、内存与 PostgreSQL 实现
│   ├── run-store.ts           # Run、Session、事件的持久化与投影
│   ├── personal-*.ts          # 个人运行、事件、容量与查询的持久化
│   ├── personal.ts            # 内存 PersonalStore 实现
│   ├── registry.ts            # 身份与配置注册表
│   └── capacity-store.ts      # Sandbox 容量持久化
├── execution/
│   ├── worker.ts              # 调度、任务租约、取消、工具与子任务编排
│   ├── runtime.ts             # Pi 与 Demo 运行时
│   ├── tool-specs.ts          # 受控工具定义
│   ├── personal-context.ts    # 个人执行上下文标记
│   ├── memory.ts              # 工作区记忆与文件操作
│   └── delta-batcher.ts       # 流式文本增量批处理
├── sandbox/
│   ├── manager.ts             # Sandbox、工作区文件与快照编排
│   ├── policy.ts              # 容量预留、配额与操作代次校验
│   ├── provider.ts            # Provider 契约与创建失败模型
│   ├── cube-provider.ts       # CubeSandbox SDK 适配
│   ├── demo-provider.ts       # 内存 Demo Provider
│   ├── lease-manager.ts       # 工作区租约与生命周期资格判断
│   ├── remote.ts              # 有界远程调用、取消与迟到结果处理
│   ├── remote-script.ts       # 在 Sandbox 中执行的可信工具脚本
│   └── skill-mounts.ts        # Skill 挂载身份、来源校验与 scope
├── mcp/
│   └── manager.ts             # MCP 发现、白名单、凭证与调用
├── skills/
│   └── packages.ts            # Skill ZIP 校验、准备、提交与回收
├── observability/
│   ├── telemetry.ts           # 指标、日志与追踪上下文
│   ├── health.ts              # Schema 版本、Worker 健康模型与有界检查
│   └── alerts.ts              # 告警规则
├── config/                    # Agent、模型、Skill 配置导入与交付 CLI
├── schedules/                 # 调度执行、历史与定时服务
├── security/                  # 策略、令牌保管与路径保护
├── tools/                     # Web 工具适配
web/src/admin/                 # React Agent/Skill/MCP/委派管理中心
migrations/                    # 按序执行的数据库迁移
scripts/                       # 冒烟、基准、验收与供应链校验
test/                          # API、业务、存储、Sandbox 与浏览器回归
```

## 添加或修改功能

- HTTP 请求解析、状态码和响应投影放在对应 `api/` 路由模块；共用请求校验放在 `api/validation.ts`，仅单模块使用的辅助函数留在模块内。
- 领域权限与跨资源业务规则放在 `domain/`，持久化查询和事务实现放在 `storage/`。运行时和任务调度放在 `execution/`；预算规则与账本放在 `domain/usage.ts`，日志、指标与告警放在 `observability/`。
- Sandbox 的编排、Provider、租约、远程脚本和挂载策略统一放在 `sandbox/`；MCP 协议适配放在 `mcp/`。路由通过 Manager 使用这些能力。
- Skill ZIP 包的本地校验与发布准备放在 `skills/`，挂载到远程执行环境的策略放在 `sandbox/skill-mounts.ts`。
- 管理中心位于 `web/src/admin/`，与聊天共享登录态。Fastify 通过 `api/web.ts` 提供构建后的静态资源；旧管理台 URL 仅跳转。
- 新路由模块导出同步 `register…Routes` 函数，在 `api/server.ts` 的 `buildAPI` 中装配；通过 `Pick<RouteContext, …>` 列出依赖。所有路由直接注册到同一个 Fastify 实例，继承统一认证、错误处理、请求审计及 multipart 支持。
- 启动配置与依赖装配放在 `app/bootstrap.ts`。`main.ts`、`worker-main.ts`、`migrate.ts` 保持稳定，现有 npm、Docker 和部署入口不变。
- 内部模块使用具体文件路径及 `.js` 扩展名导入。移动模块时同步更新 `src/`、`test/` 和 `scripts/`（包括引用 `dist/` 的脚本），以及文档中的路径。

本次目录迁移保留模块导出和业务行为，内部导入路径已更新，不在旧位置保留转发文件。

## 验证

```bash
npm run check
npm test
npm run build
npm run smoke
```

PostgreSQL 回归需要专用 `TEST_DATABASE_URL`；管理控制台浏览器测试使用本机 Chromium 或 `CHROMIUM_PATH`。环境限制用户目录写入时，可设置 `PI_CODING_AGENT_DIR` 指向仓库内的 `work/pi-agent` 运行测试。强制无跳过的完整 CI 流程见 [CI checks](ci.md)。
