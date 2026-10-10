# Run/Session/租约迁移

先停止全部旧 API/Worker，备份数据库与当前发布 commit；执行 npm run migrate，再统一
启动新版。003 同一事务回填 sessions、runs、run_events 和 event_sequences，保留 JSON
业务数据与旧 event ID；计数/Run 内容校验失败就回滚。旧租户 state 去除实体历史，新表
成为唯一来源，marker 防止重跑复活旧任务。禁止混合旧 JSONB 写入者与新行写入者。

数据库复合键包含 tenant，Run 外键引用同租户 Session；幂等唯一索引包含 Session/User/Key，
忙碌 Session partial unique index 保证 QUEUED/RUNNING/WAITING_INPUT 排他。领取和恢复
通过 runTx 锁单 Run，授权从同事务元数据读取；心跳与结束按持久 owner/expiry 再验证。
过期 RUNNING 以 WORKER_LOST_UNKNOWN_TOOL_OUTCOME 失败，不回到 QUEUED，不重放工具。

runTx 用共享元数据锁与单 Run 行锁，不能修改其他 Run、Session 或元数据；不同 Run
心跳可以并行，且不改租户 revision/JSON。普通跨实体 tx 仍串行锁定租户并 diff 写入发生
变化的实体，保留现有 ACL/Workspace/会话原子语义；此 PR 不宣称消除了所有管理面写锁。
领取候选被其他 Worker 抢先领取时重查状态并继续候选，不会领取两次。

事件独立表是安全的 per-Run 终态/恢复所需基础，event sequence 使用独立事务计数行。
该计数行仅在添加事件时竞争，心跳不写它；SSE 索引分页、通知和 delta 批量化由 #12 提供。

审核历史迁移：保存各租户 session/run/event 数量，按复合键抽样对 source JSON 与 data
规范 JSON SHA-256；检查所有非终态和持久 lease。7 项真实 PostgreSQL 回归包括双客户端
领取、同 Session/幂等冲突、失租 fencing、独立心跳重叠、元数据不重写与历史数据精确回填。

回滚先停止新版并备份：在事务内按 tenant 聚合 harness_sessions.data、harness_runs.data
和按 event_id 排序的 harness_run_events.data 到旧 state，并把 sequence 设置为独立 cursor
与现有 state.sequence 的最大值。核对全字段/计数后才启动旧版；不能恢复迁移前已过期的
旧租约或把未知 Run 改为 QUEUED。保留新表与 marker 作审核，再升级需要专门核验数据代次。

基准：npm run build；TEST_DATABASE_URL=... node scripts/bench-run-heartbeats.mjs。
本地 PG17/Node24、100 Run、200 次心跳、10 并发：模拟旧 JSON 写回 P95 113ms，新
per-Run 路径 P95 30ms，总耗时 1178ms/441ms。未采样生产 WAL/锁等待，不作为容量承诺。
部署应继续采集 pg_stat_activity 等锁等待、pg_stat_wal、心跳 P95/P99 和序列表竞争。

## 验收与扩展边界

本项验收是不同 Run 的心跳不再重写整份租户 JSONB，并保留 Session 排他、幂等和
失租 fencing。普通跨实体事务仍持有租户级元数据锁，runTx 仍取得共享元数据锁；
这是当前扩展边界，不能描述为所有租户写竞争已消除，也无需在此改写锁协议。
上述 P95 只针对给定数据集的局部心跳对比，不代表管理事务吞吐或整体生产性能。
生产结论需按 [生产验收 #18](https://github.com/Garhorne0813/pi-flow/issues/18) 门槛，用代表性数据集采集
锁等待、WAL、吞吐及 P95/P99；不同场景和 commit 的数值不能直接拼成整体提升比例。

## 第三轮：历史数据读取验收

Worker 每租户每次只调用一次 `listClaimableRuns(now,64)`，分别使用 QUEUED 与租户/到期租约
partial index，最多返回 64 个 ID；不读取租户元数据、Session 或 Event。候选不是领取凭据，
领取/失租恢复仍在 runTx 内重新校验持久状态、owner 和 expiry，保持租户轮转。
目标 Run 的 `readRun` 只读取目标与祖先、相关 Session、Workspace ACL、Agent 和技能；
只有执行上下文显式请求 Session entries。Agent/技能/Workspace 普通列表通过字段投影读取，
HTTP 响应审计使用原子追加，不再为了审计加载所有 Run/Event。

复现：`TEST_DATABASE_URL=... node --import tsx scripts/acceptance/worker-history.ts`。
真实 PG17、每阶段 100 个顺序扫描与 idle tick、热缓存、单租户：20,001 Run / 1、10,001、
100,001 Event；扫描始终返回 0 行、JSON `[]` 2 字节、2 个共享块。一次本地实验，
10,001→100,001 Event 的 scan P95 0.967→0.874 ms、tick P95 1.152→0.966 ms。
这些值只说明该历史扫描路径未随事件数线性增长，不代表生产吞吐或冷缓存 SLO。
测试同时检查实际查询计划无历史 Seq Scan、候选上限、跨租户隔离、祖先撤销和 ACL。

完整 read()/跨实体 tx 和统计报告仍可载入历史；JSONB 鉴权投影也仍有服务端 TOAST
解压成本，审计原子追加仍改写 JSONB。长期数据治理独立跟踪 [#39](https://github.com/Garhorne0813/pi-flow/issues/39)。
003 增加租户到期租约索引并完整校验 Session/Event 数据和 Run/Event 数量；重复运行
可补建索引，但检测到回滚后的非空旧聚合时会拒绝盲目再升级。
