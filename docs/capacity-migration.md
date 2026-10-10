# Sandbox 容量表迁移与回滚

停止所有 API/Worker 后备份数据库，执行 npm run migrate（按顺序、同一事务运行
001/002），再统一启动新版。禁止新旧版本混跑：旧版仍写全局 JSONB，新版读写
harness_sandbox_leases，双写会破坏代次和额度保证。

002 按 tenant_id/workspace_id 回填每条容量记录，包括文件/孤儿键、operation、
Sandbox ID、user、状态、毫秒 updated_at。迁移逐字段双读校验源行，冲突或不匹配
会失败；capacity-v2 marker 保证重复 migrate 不复活已释放或删除的旧行。旧表保留
作迁移审核，但切流后不是当前状态。发布前保留源/目标计数及按复合主键抽样的
规范 JSON SHA-256，核对所有 reserved/unknown/released 条目。

预留和转换共用 transaction-scoped 全局 advisory lock (134697,13)。在该锁内用
索引计数后预留，不能 COUNT 后无锁 INSERT；有范围的转换只读取/写入目标行，
不会重写其他租户的容量。quota admission 仍有全局竞争，验收目标是消除全局 JSONB 全量写入，
保留原子配额约束，不能描述为消除全局容量竞争。只有代表性实际压测与 advisory lock
等待证据确认该锁是瓶颈后，才考虑独立计数器，并保留相同正确性测试约束。
保留 reserved/unknown 计数、released tombstone 和完整 expected-entry CAS。

监控 charged/unknown 数量、advisory lock 等待、预留延迟、表/索引大小和 WAL。
状态/user/operation/reconcile 索引支持计数与后续孤儿扫描。

回滚：停止新版并备份当前新表。在事务内把新表重新聚合写入旧表，然后校验所有
字段与计数，再启动旧版；不要直接拿迁移前 JSONB 恢复当前配额：

```sql
BEGIN;
SELECT pg_advisory_xact_lock(134697,13);
INSERT INTO harness_sandbox_capacity(id,state)
SELECT 1,jsonb_build_object('entries',COALESCE(jsonb_object_agg(
  '[' || to_jsonb(tenant_id)::text || ',' || to_jsonb(workspace_id)::text || ']',
  jsonb_strip_nulls(jsonb_build_object('tenantId',tenant_id,'workspaceId',workspace_id,
  'userId',user_id,'state',state,'sandboxId',sandbox_id,'operation',operation,'updatedAt',updated_at))
), '{}'::jsonb)) FROM harness_sandbox_leases
ON CONFLICT(id) DO UPDATE SET state=excluded.state;
COMMIT;
```

回滚仍保留新表供审核；再次升级须先核对源/目标代次，禁止直接删除迁移 marker
并覆盖当前记录。

本地 PostgreSQL 17 合成基准：1000 行、200 次更新、10 并发，旧 aggregate 总耗时
1518ms、P95 138ms；规范行更新 238ms、P95 18ms。命令：
TEST_DATABASE_URL=... node scripts/bench-capacity.mjs，报告 work/capacity-benchmark.json。
这是转换存储成本的局部对比，不包含网络/SDK 或预留计数，不是生产容量 SLO。

## 性能证据口径

上述合成基准测量容量状态转换的存储成本；两种路径保留各自锁协议，未覆盖完整
配额准入/索引计数、跨租户混合负载、网络或 Cube SDK。P95 差异不是全局竞争消失
的证据，也不能推导生产吞吐或容量 SLO。发布前应同时记录数据集、版本、并发度、
advisory lock 等待、准入延迟和 WAL；正确性验收与生产规模验收分别报告。
