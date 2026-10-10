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
