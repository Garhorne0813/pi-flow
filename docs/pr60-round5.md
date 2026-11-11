# PR #60 第五轮：一致性修复与执行计划

本轮以 `54b9667` 的 schema v9 为基线，修复确认的审计双写和 Schedule 历史读取问题，并验证、优化两项大规模查询风险。新增 `012_personal_queue_frontiers.sql`，个人 schema **v10**；共享 schema 仍为 v6。部署需停止旧 API/Worker，执行全部迁移后启动；Compose 挂载 001–012，空卷期望 `6:10`。

## 审计只写独立表

删除 scheduleTx 在 saveState/saveRecords 之后的旧 state.audit UPDATE。新用户状态使用 metadata(emptyState()) 初始化，不再包含旧 audit 字段。012 将遗留 JSONB 中尚未入表的审计补入 personal_audit，已有同 ID 的规范记录优先，再删除旧字段；回滚和重复执行有回归。

数据库测试实际触发并结算 Schedule，确认 schedule.fire 审计只出现一次，user_state 不包含 audit，用户元数据的 xmin 和内容保持不变。

## Run 队首投影

原 DISTINCT ON 需要扫描每个用户的全部积压索引项。新增 personal_run_work，每用户保留最早 QUEUED Run 及最早持有租约的 Run。三个语句级触发器以 transition tables 汇总本次受影响用户，按用户顺序锁定投影，再使用已有索引 LIMIT 1 更新队首；同一事务提交或回滚。普通计数更新不改变状态/租约，不重建投影。迁移回填已有队列，readiness 检查投影表、索引和触发器启用状态。

候选轮询只读该投影：用户游标之后、回绕区间和到期租约三个来源各自先 LIMIT，最终最多排序 3×64 个候选。公平轮转和认领时的所有权/用户串行检查保留。代价转移至 Run 状态、租约和删除的写入事务；心跳续租也可能更新队首投影。外部绕过触发器或直接 TRUNCATE Run 表时，必须同时重建投影；正常 API 的 INSERT/UPDATE/DELETE 已覆盖。

回归覆盖并发状态更新、续租/到期、取消、回滚、删除、旧数据回填及触发器禁用后的 readiness 拒绝。

## 沙箱维护排序与更新

增加与 checked_at、last_used_at NULLS FIRST、user_id、workspace_id 顺序相同的部分复合索引。执行计划还发现，原 UPDATE ... FROM due 即使只选中 128 个候选，也可能通过 Hash Join 再顺序扫描整张投影表。现在在同一语句里物化并锁定候选的 ctid，再通过 TID Scan 更新这些行。ctid 仅在当前语句中使用，不持久化、不跨请求传递；原维护领导租约与 Workspace 锁保留。

**这不表示所有分布下扫描量恒定。** 为保留 checked_at 公平轮转，资格过滤仍在有序索引上执行。当大量未到期行排在少量已到期行之前时，会过滤较多行，下面的反向分布实测明确记录了这一退化。没有加入会延迟大量到期任务的固定预扫描截断，也没有宣称该风险完全消失；如需进一步限制最坏扫描量，需要物化 next_due_at 等专门的到期队列。

## 单 Schedule 历史分页

GET /api/v1/schedules/:id/runs 改为定向读取目标 Schedule 和它的 Fire，使用专用复合索引。查询参数 limit 默认 50、最大 100；cursor 为服务端返回的时间/id 复合游标。按 scheduledFor DESC、id DESC 排序，响应为 {items,nextCursor?}。继续读取下一页需传入 nextCursor；一次响应不再返回全部历史。

游标绑定 scheduleId，校验格式和边界；每页在只读重复读事务中校验所有者并读取 limit+1 项。相同时间戳由 id 区分，新插入的较新 Fire 不会导致后续页重复。内存回退具有相同分页语义。回归在同一用户另一 Schedule 下放入 100,000 个 Fire，验证目标分页、所有者隔离、非法参数、并发插入和小量返回字节。

## 10 万规模实测

原始 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) 及摘要见 [执行计划报告](benchmarks/pr60-round5-plans.json)。PostgreSQL 17.6、默认规划器、无索引提示；每组先执行基线再执行新查询，缓存可能利于后者。表为新插入数据，Run 每条使用独立 Session 以满足忙碌会话唯一约束；候选测试只需要 Run 物理列，不模拟完整模型 payload。时间是单次执行值，不是 P95，也不作为生产 SLA。

“行计数”是相关扫描节点的 Actual Rows + Rows Removed by Filter/Index Recheck，乘以 Actual Loops 后求和；包含重复访问，不等于不同记录数，也不包括不可见/死亡索引项和所有页级工作。完整 buffer、heap fetch 和节点信息保留在原始计划中。

| 场景 | 基线扫描计数 | 新扫描计数 | 基线 / 新执行时间 |
| --- | --- | --- | --- |
| 单用户 100,000 QUEUED Run | 100,000 Run | 0 Run，3 次投影行访问 | 55.680 / 0.062ms |
| 1,000 用户共 100,000 QUEUED Run | 100,000 Run，排序最多 100,000 行 | 0 Run，128 次投影行访问，最终排序 128 行 | 145.894 / 0.178ms |
| 100,000 Workspace 全到期 | 100,128，排序 100,000 行 | 256，无排序 | 224.530 / 2.598ms |
| 100,000 Workspace，10% 到期且位于轮转前部 | 10,128，排序 10,000 行 | 256，无排序 | 28.401 / 2.996ms |
| 100,000 Workspace，90% 未到期但 checked_at 更早 | 10,128，排序 10,000 行 | **90,256**，无排序 | **31.644 / 72.494ms** |

10,000 Workspace 的全到期、常规混合和反向混合分布也保留在报告中。最后一组表明新索引并非对所有分布都更快：排序和二次整表更新已消除，但公平轮转与到期过滤的组合仍有最坏情况扫描风险。当前维护每周期才执行一轮，此结果用于评估该风险，而非掩盖它。

CI 增加相同的 100,000 Run 和 10,000/100,000 Workspace 计划回归，断言候选不再扫描 Run 表、候选小排序有界、维护没有 Sort，且常规分布只访问选中批次；反向分布被测量但不作恒定扫描断言。运行方式：

```sh
TEST_DATABASE_URL=postgres://... node --import tsx scripts/acceptance/queue-plans.ts
```

本地全量强制验收 **322 通过、0 失败、0 跳过**。类型检查、构建、Demo 冒烟和差异检查通过。上一轮 5 分钟 HTTP、500 SSE 和 100 并发 Run 报告仍是 v9 基线；本轮重新运行 CI 中的短执行热路径验收，不把旧报告冒充 v10 的完整长测。
