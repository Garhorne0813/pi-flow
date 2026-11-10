# PR #60 第八轮：旧链兼容、Memory 单租约与统计聚合

以 `17932ab`（v12）为基线修复三个问题。新增
`015_personal_legacy_tasks_stats.sql`，个人 schema **v13**，共享 schema v6。
升级前停止旧 API/Worker、备份数据库，执行全部迁移后启动。Compose 挂载
001–015，期望 **6:13**，已单独验证全部源文件及容器目标路径的对应关系。

## 旧任务链

015 按原 taskIdentity 的追溯规则递归回填 taskId/rootRunId：已有稳定身份优先；
否则先选择 parentRunId，没有时通过 resumedFrom 对应的 Interaction 找前序 Run。
只在同一个 user_id 内追溯，缺失前序时以最后一个存在的 Run 为根。
不改配置、Actor、Token、状态、原 parent/resumedFrom 引用或其他快照字段。

回填在单一 DO 事务内执行，循环链使迁移失败且不提交部分身份。
修复循环数据后可重试；重复执行对已回填记录无作用。
最后补齐失败事件索引并发布 v13；readiness 要求版本和有效索引。
旧 Writer 必须在升级前停止，新 API/Worker 创建的 Run 均保存稳定身份。

真实 PostgreSQL 回归覆盖完全没有 taskId/rootRunId 的 parent 链、连续两级
resumedFrom 链、从 Root 或末端 Child 取消整条链、快照保持、迁移未提交/回滚及
幂等重放。另覆盖循环拒绝且不部分回填、断链和跨用户前序引用的原有行为。
循环不会被静默分成多个可执行任务。

## 手动 Memory

mkdir/find/读取各笔记/写主题/写 MEMORY.md 在同一个 withWorkspaceLease 中执行，
只准备、获取和释放一次沙箱租约。原自动执行时的 Memory 配额/审批路径保持原状。
文件 API 也复用此工作区管理器；其只读检查通过 readMetadata 读取 Workspace、
Skill 和策略，不再映射为 workspaceTx。租约获取、续期和状态变更仍使用写事务。

批处理中每个远程步骤前检查账号 enabled/JWT 到期、租约所有权、工作区权限、
当前 Bundle 授权和 Skill；写入前读取当前 kill-switch。AbortSignal 贯穿整次操作，
原迟到回调、清理和容量 fencing 机制继续适用。

同规模 5,000 Run / 50,000 个 1 KiB Event / 各 5,000 Audit、Usage、Fire 下：

| 手动写入路径 | v12 上轮 SQL 报告 | 本轮 SQL | 本轮返回字节 |
| --- | ---: | ---: | ---: |
| 成功 | 496 | 190 | 16,867 |
| 沙箱写失败 | 450 | 144 | 18,261 |

v12 数字是上一轮记录，本轮数据独立采样；减少约 62% / 68%。保留两条独立
attempt/success 或 failed 审计。事务放大显著下降，但容量和沙箱生命周期仍有成本。
返回字节是客户端行 JSON 大小，不代表数据库页读取量。

回归直接观察每个远程步骤的持久 lease owner，确认一整次写入只使用一个 owner。
两个并发写请求在租约上串行，最终索引同时保留两条笔记。测试在主题写入后撤销
write 策略、账号、Workspace ACL 或 Bundle 授权，均阻止后续索引写；另验证中止
清理、过期 JWT 拒绝、原成功/失败审计及持久读取。远程文件与审计仍不是分布式事务，
失败可能留下主题文件而未更新索引。

## 管理统计

个人 PostgreSQL 的 GET /api/v1/admin/stats 使用一次 MVCC 快照的单条 SQL：
聚合 Run 状态/持续时间、关联未解决 Interaction 与 WAITING_INPUT Run，使用
personal_tool_failures 部分索引计数 tool.failed。只向应用返回汇总结果，不读取
Session transcript、审计、Usage 或 Schedule，也不传输 Run/Event 历史 JSON。
保留原管理员权限和响应字段；共享/内存存储使用原统计实现。

0 与 50,000 条普通历史 Event（另有 5,000 Run）下，HTTP 均为 2 条 SQL
（身份 SELECT + 统计），返回数据 186 / 189 字节。本地样本 12.8 / 8.0ms；
EXPLAIN ANALYZE 全查询约 6.1ms，失败事件索引节点访问 3 条失败记录。
测试同时验证状态计数、平均时长、已解决或关联 Run 已结束的 Interaction 排除、空用户、
跨用户隔离、非管理员拒绝，以及实际计划中的失败事件部分索引。

这些统计没有增量物化：Run 状态/时长仍遍历 Run，Interaction 仍需 JSONB 提取，
精确失败计数随失败记录数量增长。优化消除了普通 Event 和无关实体的全量加载，
不声称统计延迟与所有历史量无关。采样及计划摘要见
[本轮记录](benchmarks/pr60-round8.json)。

## 验证

新增 5 项真实 PostgreSQL 回归；本地全量强制验收 **337 通过、0 失败、0 跳过**，
最后的 3 项 Memory 批处理/复核回归通过。类型检查、构建、Demo 冒烟、vendor、
配置校验、Prettier、脚本语法及差异检查通过。npm audit 无 high/critical，保留
2 moderate。当前提交 CI 结果见 PR 描述。
既有 v9 长测是历史基线，本轮不重复；第五轮沙箱维护反向分布扫描风险继续保留。
