# pi-flow 简化设计

本设计采用 **数据库中的当前 Agent 配置 + 每个 Run 的执行快照**。它取代此前 Git 发布、不可变 Agent 版本和 Session 自动升级的方案。原文保留在 [历史架构参考](architecture-reference-v1.md)，实际能力边界见 [运行说明](personal-platform.md)。

## 1. 保留的架构边界

- API 提供 HTTP/SSE，负责认证、配置管理、会话和用户资源访问。
- Worker 在沙箱外驱动模型、审核工具权限、管理审批和执行任务。
- PostgreSQL 保存当前配置、用户数据、Run 状态、事件和租约。
- 每个用户有一个私有持久工作区；沙箱释放不删除持久存储。
- V1 同一用户的执行串行化；其他 Provider、多会话并发等按实际实现状态单独验收。

## 2. 三个核心对象

| 对象 | 内容 | 更新规则 |
| --- | --- | --- |
| Agent | 稳定 id、当前 AgentConfig、enabled、allowedUsers、updatedAt | 管理 API 原地更新，同一 id 不创建历史版本 |
| Session | userId、agentId、cwd、title、transcript | 只关联 Agent，不记录 active/effective 版本 |
| Run | 输入、agentId、capabilities 快照、解析后的 model、cwd、预算、任务链、执行状态和事件 | 创建时记录快照；运行和续跑不重新套用当前 AgentConfig |

生产 Agent 配置的权威表为 `personal_agents`。数据库中可以没有 Agent，此时列表为空，管理员可直接通过 API 创建，不要求先准备配置文件或 Git 仓库。

`configDigest` 只是帮助定位 Run 配置的摘要，不是发布版本、外键或历史配置的寻址入口。`revision` 只防止管理端并发编辑覆盖，也不用于执行时版本选择。

## 3. 配置管理

### 3.1 唯一主路径

`GET /api/v1/admin/config/agents` 返回 `{revision,items}`，其中每项直接包含当前 Agent 的 `id/config/enabled/allowedUsers/updatedAt`。

`POST /api/v1/admin/config/agents` 接受：

```json
{
  "revision": 0,
  "agents": [{
    "key": "assistant",
    "enabled": true,
    "config": {
      "name": "Personal Assistant",
      "systemPrompt": "Help the user with their private workspace.",
      "model": "default",
      "tools": ["read", "ls"]
    }
  }]
}
```

- 这是完整当前清单，允许空数组；省略的已有 Agent 会被禁用。
- 整份配置先校验工具、Skill、MCP、子 Agent 等引用，再在事务内更新。
- revision 不匹配返回 `409 CONFIG_REVISION_CONFLICT`；失败不修改已有配置。
- 成功返回新的 `{revision,items}`，不生成 publication 或 AgentVersion。
- 禁用与 allowedUsers 属于实时授权；已经创建的 Run 在后续授权检查时也会被阻止。

`GET/POST /api/v1/admin/config/global` 管理工具禁用策略、模型目录和加密密钥引用。它有独立的编辑 revision，更新全局配置不会重新保存或重新发布 Agent 配置。

### 3.2 可选初始化与导入

`config/` 是示例和可选的目录导入格式，不是运行时权威源。可以放在 Git 中，也可以来自其他文件目录。

- `npm run config:import -- --check`：只校验目录，无需数据库。
- `npm run config:import`：将目录导入空的 Agent 配置。
- 已有 Agent 时拒绝普通导入；明确指定 `--replace` 才覆盖现有配置。
- 导入仍通过当前配置的校验和更新逻辑；之后管理 API 的修改以数据库为准。
- API/Worker 启动不读取目录、不做自动同步，不要求目录存在。
- Demo 仅在 Agent 清单为空时创建内建示例，不覆盖已保存配置。

目录格式可以将 HOUSE.md、SYSTEM.md、AGENTS.md 和内联子 Agent 合并成 AgentConfig。合并结果保存在数据库，运行时不依赖原始文件。

## 4. Run 的最小快照

创建新的根 Run 时：

1. 校验 Session 所属用户和 Agent 当前是否可用。
2. 读取当前 AgentConfig，并解析默认模型。
3. 保存本次有效配置到 `Run.capabilities`，同时保存 `model/cwd/agentId/configDigest`。
4. 创建任务链标识，保存事件，再由 Worker 认领执行。

同一幂等键及相同输入返回原 Run，不重新生成配置快照。

快照包括本次提示词、工具清单、审批模式、Skill/MCP 引用、内联子 Agent 定义、Token 访问开关、记忆规则和预算。它不冻结整个工作区、记忆内容、外部服务、密钥值或整套 Skill 依赖环境，因此不承诺完整重现历史运行环境。

```text
Agent 当前配置 A ── 创建 Run 1 ── 快照 A ── 排队/执行/等待/续跑
       │
       └── 管理端编辑为 B ── 创建 Run 2 ── 快照 B
```

新一轮 Run 直接读取 B，不需要升级 Session，也不再发送 `session.version.upgraded`。

## 5. 审批、子 Agent 与实时安全

审批/提问仍通过 Interaction 暂停并生成续跑 Run。续跑继承原 `capabilities/model/cwd`、步骤/Token 计数、任务链和用户 Token 密文；它不重新使用管理员刚编辑的配置。

审批与原始工具名称及参数绑定。批准后仍检查当前授权、平台禁用开关和 edit 文件前置条件。配置快照不能绕过以下实时限制：

- 用户身份失效或被禁用；
- Agent 被禁用或调用者被移出 allowedUsers；
- 全局工具 kill-switch；
- Skill/MCP 撤销、MCP 工具白名单收紧；
- 用户取消、预算耗尽或租约丢失。

模型目录和凭证不纳入 Run 快照，在模型执行时另行解析。

修改 Agent 的普通提示词、工具清单和审批模式只影响新根 Run。若需立即阻止某个工具，应使用全局禁用策略；若需停止某个 Agent 的执行，应禁用该 Agent。

子 Agent 沿用独立 Session/Run 和父级能力求交逻辑。内联定义来自父 Run 快照，子 Run 保存自己的有效配置，不需要临时创建或发布 AgentVersion。`delegate_to_agent` 使用 `agentId`；旧 `agentVersionId` 参数仅作旧引擎兼容别名。

远程调用结果未知仍失败关闭，不因为此次简化而增加重试或重新执行已审批操作。

## 6. 数据迁移与兼容

个人 Schema 当前版本为 **11**。`008_editable_agents.sql` 完成 v6 可编辑 Agent 转换；`009_personal_execution_indexes.sql` 在完成调度归一化和执行索引后发布 v7。`010_personal_session_pagination.sql` 为 Session 列表补齐分页索引并发布 v8。011 拆分审计、Usage/资源及工作区运行投影，增加事件计数器和全局候选索引并发布 v9。012 增加 Run 队首投影、语句级维护触发器及维护/历史分页索引，发布 v10。013 回填用户 RUNNING 标记并为可执行队列增加部分索引，发布 v11。readiness 要求 v11、相关表、有效热路径索引及启用的队首维护触发器；共享引擎的 schema 仍为 v6。

- 将 v5 的 active Agent 配置迁入 `personal_agents`，保留稳定 key 和实时访问限制。
- 为旧 Run 补足必要快照和 agentId；保留已有解析模型与任务链。
- 从个人 Session 删除 agentVersionId/effectiveVersionId，保留对话和 cwd。
- 旧 AgentVersion/publication 表保留为历史档案，个人平台停止读写这些表作为运行依赖。
- 迁移可重复执行，不会用历史配置覆盖后续管理端编辑。
- `harness_*` 旧共享工作区引擎保留原兼容契约；本次不推断旧共享数据的个人归属。

部署时先停止旧 API/Worker，执行迁移，再启动新进程，避免两套配置语义同时写入。

## 7. 验收要求

1. 删除或不挂载 config 目录，Demo 仍可启动并完成会话；生产可用 API 初始化 Agent。
2. 编辑 Agent 保持 id 稳定，不新增 AgentVersion 或 publication。
3. 排队及执行中的 Run 继续使用自己的快照，下一根 Run 使用新配置。
4. 修改 Agent 后批准旧 Interaction，执行原工具载荷并继承原配置。
5. 禁用 Agent、收紧访问列表、关闭工具仍能阻止旧 Run。
6. 全局配置编辑不影响 Agent 的编辑 revision。
7. 迁移后的旧等待交互任务可续跑，且不依赖旧版本表的 enabled 状态。
8. 类型检查、原有与新增测试、真实 PostgreSQL 测试、构建、Demo 冒烟通过。

高频事务的范围和测量限制见 [数据库运行热路径](runtime-hotpaths.md)。
