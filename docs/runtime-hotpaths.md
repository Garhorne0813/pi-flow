# PR #60 数据库高频路径修复

本轮基于 `0b2983e` 审查的九项问题，个人 schema 升至 **v9**。部署时停止旧 API/Worker，执行包含 `011_personal_runtime_hot_paths.sql` 的全部迁移，再启动新进程；共享 schema 保持 v6，Compose 空卷检查版本为 `6:9`。

## 行为与存储边界

1. **身份和 HTTP 审计**：已注册身份使用 SELECT；只有首次注册尝试 INSERT，冲突后重新 SELECT，不执行无意义的 UPDATE。普通 GET/HEAD/OPTIONS 只记录 HTTP 日志，不持久化逐请求审计；写操作和显式安全/业务审计写独立 append-only `personal_audit`。审计不再扩展用户 JSONB，也不通过用户元数据行初始化。原审计随 011 迁移，缺失或禁用身份仍拒绝。
2. **空闲 Worker**：直接从 `personal_runs` 取全局候选，一次最多 64 项，按用户游标轮转，优先处理该用户的过期租约；不枚举历史用户，不逐个调用候选查询。满并发时跳过候选查询。空闲兜底仍为 250ms，一轮一条候选 SELECT；Worker 健康写入仍为每 5 秒一次。
3. **执行事务**：Usage reserve/settle、consume、checkpoint、工具启动/审计/Todo、审批挂起、子任务及结束结算使用 `executionTx`。锁定用户元数据和目标任务链，仅加载相关 Run、无 entries 的 Session、对应 Todo/Interaction；只有 checkpoint 显式写入 transcript。存储层拒绝越界元数据变更。模型请求存于 `personal_usage_requests`，预算查询在数据库聚合本月其他任务并读取当前任务记录，不加载全部历史执行实体；reserve 和 settle 仍受用户事务锁保护，保留并发配额与幂等结算。
4. **流式事件**：默认聚合窗口从 50ms 改为 200ms，字符阈值从 4096 改为 16384；一次 flush 的片段在同一事务中批量 INSERT，完成事件必须等待之前的文本提交。独立的用户 Event ID 和 Run 内 seq 小计数器分配顺序，事件追加只校验 Run 租约/状态，接触计数器和事件表，不重写 Run JSONB、Session 或用户元数据。事务提交后一次 NOTIFY 唤醒订阅者；背压上限和错误传播保留。
5. **沙箱维护**：011 物化工作区运行状态并补齐旧活跃沙箱租约。维护直接从带索引的 `personal_workspace_runtime` 领取最多 128 个到期候选，数据库时间租约让多个 Worker 每周期只执行一轮候选维护；原工作区锁继续防止同一沙箱并发远程操作。无沙箱用户不进入候选集合。失败候选按 checked_at 轮换，避免长期占据批次前端。兼容共享存储的回退路径也只读 Workspace 元数据。
6. **SSE**：在首个事件查询前完成 LISTEN 订阅，保留 pending 标记处理查询/等待间通知。无事件时以通知为主，兜底由 250ms 延长为 5 秒；断线唤醒后先重建 LISTEN，再继续追赶查询。JWT 到期和每秒账号复核独立，背压连接仍能撤权关闭；结束时释放订阅和定时器。
7. **Run 心跳**：每秒的取消、截止时间、实时策略检查保留为定向只读查询，账号复核仍每 5 秒一次。租约每 5 秒用 `run_id + lease_owner + state + 未过期 + 未取消` 的条件 UPDATE 延长至 30 秒，不读取 transcript 或重新序列化整个 Run。所有权丢失、取消或撤权仍中止执行；共享存储使用原有兼容路径。
8. **常见读取**：Session detail 仅查询对应 Session、Workspace ACL 和 Todo；Usage 仅查询模型/资源记录（Run Usage 限定 Run）；Schedule 读取自己的专用表；Sandbox status 仅读 Workspace 元数据。普通 Run 状态读取不会打开历史 Event 关系。
9. **平台配置**：PostgresRegistry 每次先查数据库 revision。revision 相同则复用不可变快照，不传输 document 或聚合全部 Agent；变化时在同一语句中获取新配置和 Agent。事务内读取复用当前连接，并保留“取得锁后、远程 dispatch 前”复核，缓存不绕过 kill-switch。只读 Workspace 等不需要平台字段的元数据访问跳过 overlay。

011 同时迁移审计、Usage/资源记录及活跃 Workspace 投影，并最后发布 schema v9。readiness 检查新增表与索引的归属、indisvalid/indisready；事务回滚及重复迁移有真实 PostgreSQL 回归。

## 验证方式

`test/runtime-hotpaths.test.ts` 在 CI 中使用 1,000 个空闲用户、5,000 个历史 Run / 50,000 个 1 KiB Event、12 个并发 Run、20 个 SSE 连接及短轮询窗口，断言：

- 空闲 Worker 20 轮查询数在一个用户和千用户下相同。
- 普通 GET 产生 0 条写入语句；常见小对象读取不读取历史 Event。
- SSE 查询频率符合通知 + 5 秒兜底，而非每连接每秒 4 次事件查询。
- 实际模型预算、文本流、工具、consume、checkpoint、完成和清理不调用全历史加载，也不反复传输 Agent 集合。
- 多 Worker 维护只有一方处理同一候选。

单独执行完整量级基准：

```sh
PI_CODING_AGENT_DIR=work/pi-agent \
TEST_DATABASE_URL=postgres://... \
node --import tsx scripts/acceptance/runtime-hotpaths.ts
```

默认包含 1,000 个空闲用户、100 个并发 Run、500 个空闲 SSE，以及持续 **300 秒、约 10 请求/秒**的 HTTP 状态轮询。基准在独立 schema 中创建/删除自己的数据，记录客户端 SQL 调用、读/写行数、返回字节、SQL/事务 P95、WAL LSN 差值和 100ms 锁等待采样。如果数据库加载了 `pg_stat_statements`，同时记录实际语句调用数、行数、执行时间和 WAL。`BENCH_RESET_STATS=true` 仅用于专用测试实例，明确要求重置语句统计；默认不重置。可通过 HTTP_DURATION_MS、ACTIVE_RUNS、SSE_CONNECTIONS、SSE_DURATION_MS 调整规模。

完整实测结果见 [原始报告](benchmarks/pr60-runtime-hotpaths.json)。WAL LSN 为实例级指标，锁等待为采样估计，客户端行数不是服务端扫描行数；这些延迟不构成生产 SLA。CI 并行运行时应以客户端计数断言为准，实例级统计可能包含其他测试；独立长测在没有其他应用工作的专用本地 PostgreSQL 上执行。

## 完整量级实测

专用本地 PostgreSQL 17.6，已启用 pg_stat_statements；使用模拟模型和 DemoSandbox，通过实际 Worker、预算、工具和 checkpoint 路径执行，不代表真实模型/远程沙箱吞吐能力。100 个 Run 观察到同时运行峰值 100。

| 场景 | 实测结果 |
| --- | --- |
| 一个用户 / 1,001 个用户，空闲 Worker 各 20 轮 | 均为 20 条 SELECT，0 写入行，候选返回 0 行 |
| 常见 GET 共 50 次 | 0 条写入语句，0 次历史 Event 查询 |
| 状态 GET 持续 300 秒 | 3,008 请求，9,024 条 SELECT，0 条写入语句；响应 P95 6.16ms |
| 500 个空闲 SSE，10.08 秒 | 5,999 次 SELECT，含 1,000 次事件查询；每连接约 1.19 次 SELECT/秒，0 条写入语句 |
| 两个维护实例、千个空闲用户和一个到期沙箱 | 仅一个实例暂停该沙箱；未查询历史 Event 或枚举用户 |
| 100 个并发 Run | 全部完成，约 7.52 秒；客户端 30,103 次 SQL、4,793 个写入行，约 301.03 次 SQL/Run、47.93 写入行/Run；0 次历史 Event/完整历史状态读取，0 次 Agent 集合传输 |
| 模型执行 WAL / 事务耗时 / 锁等待 | 语句归因 WAL 6,887,353 B（约 68,873.53 B/Run）；事务 P95 36.12ms；采样最多 5 个等待者，累计等待估计 4,429.68ms |

5 分钟轮询的语句归因 WAL 为 0，实例 LSN 差值为 **883,880 B**；500 个 SSE 的对应值为 0 与 88 B。实例增量不能直接归因于这些读取请求，也不能用语句值宣称实例完全没有 WAL。本次没有进一步拆分后台/实例级 WAL 来源。客户端计数和 pg_stat_statements 的窗口边界、BEGIN/COMMIT/通知等计数范围不同，原始报告同时保留两组数值。

全量强制验收 **317 通过、0 失败、0 跳过**，另有通知断线重连/预算/迁移的 3 项定向回归通过；类型检查、构建、Demo 冒烟及差异检查通过。

## 保留的限制

- 未把所有管理/Session 编辑/审批响应的兼容完整状态事务改成定向操作，不能将本轮结果解释为全部 API 都与历史规模无关。相关模型执行高频路径不再使用该回退。
- Usage report 仍按原契约返回相关请求记录；预算聚合的数据库工作量随本月请求量变化。Worker 的服务器端候选扫描量随待执行队列变化，深 OFFSET 分页也不是常数成本。
- 工作区、Todo、Interaction 和部分配置仍为 JSONB；字段提取可能有 TOAST 成本。revision 缓存避免数据库反复聚合，但缓存快照的复制仍有应用端成本。
- 维护租约默认一个 sweep 周期，进程故障后由下一周期接管，单轮最多 128 项；工作区租约继续保护远程资源。没有承诺全局严格 FIFO。
- 文本批量落库将正常推送的聚合等待上限增加到约 200ms；通知不可用时事件追赶兜底为 5 秒，账号撤权和 JWT 到期不受该间隔控制。远程工具与数据库不构成分布式事务，未知执行结果、取消和部分文件写入仍沿用原有故障语义。
