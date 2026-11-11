# PR #60 第六轮：可执行候选与定向写事务

本轮在第五轮 `6309150` 上修复三条执行路径。新增迁移
`013_personal_dispatchable_sessions.sql`，个人 schema 为 **v11**；共享 schema
仍为 v6。部署时停止旧 API/Worker，顺序执行全部迁移，再启动新进程。

## Worker 候选

`personal_run_work.running` 与认领阶段的用户 RUNNING 检查一致，由现有事务内
语句级触发器维护；013 回填既有数据，也覆盖没有 lease 的 RUNNING 行。
普通 QUEUED 候选只读取 `NOT running` 的用户，并使用新部分索引。
过期 lease 仍从独立来源返回，恢复旧 Run 后才重新放行用户队列。
WAITING_INPUT 的既有执行语义不变。

真实 PostgreSQL 回归中，一个 Worker 持有长 Run、同用户另一 Session 排队，
两个空闲 Worker 合计 20 次 tick：20 条候选 SELECT、**0 次 claim、0 个认领事务**。
长 Run 完成后排队 Run 正常执行；模拟丢失 Worker 的过期 lease 后，先恢复旧
Run，再执行下一条队列。另覆盖迁移回填、无 lease RUNNING 的 INSERT/DELETE、
既有并发入队/状态转换/回滚及 100,000 Run 查询计划。

## Session 写事务

新增 `sessionTx`：按原锁顺序锁定用户状态、目标 Session，使用已有 Session
未完成 Run 索引检查 QUEUED/RUNNING/WAITING_INPUT，保留与 admission 的互斥。
创建只读工作区和当前平台 Agent 配置；修改、删除、Fork 只读目标 Session。
PATCH 保留完整 Session 响应，Fork 复制目标 transcript；这两条路径仍读取目标
entries。软删除通过 SQL 合并保留 entries，无需向应用传输 transcript。
审计仍使用规范化追加表；事务失败整体回滚。

测试增加 5,000 条终态 Run、50,000 条 1 KiB Event、各 5,000 条审计、Usage
及其他 Schedule Fire，实际 HTTP 采样如下。字节数是 SQL 返回行 JSON 序列化
大小，含 registry 缓存复核等查询；它不表示数据库内部页读取量。

| 操作 | SQL 语句数 | SQL 返回字节 |
| --- | ---: | ---: |
| POST Session | 8 | 644 |
| PATCH Session | 8 | 676 |
| Fork | 10 | 691 |
| DELETE Session | 10 | 634 |

断言未查询历史 Event/Audit/Usage/资源记录，返回量有上界。
工作区元数据通用 SQL 中的 Schedule CASE 分支未被选中；未将 SQL 文本出现表名
误算成实际历史读取。另验证软删除和 PATCH/Fork transcript、跨用户拒绝访问、
busy Session 的 cwd/删除/Fork 拒绝，以及与新 Run admission 的跨客户端竞争。

## 手动 Schedule

`manual()` 复用 `scheduleTx`，捕获请求触发时间并加载该 Schedule、必要的
Session/未完成 Run、待结算 Fire 及同一 manual 时间的 Fire，继续原子保存。
保留原有同时间戳去重：两个并发请求使用同一触发时间时返回同一 Fire/Run。
不同时间戳的请求仍是不同触发，不承诺跨时间戳的请求幂等。

同规模历史量下，两次并发真实 HTTP 请求合计 30 条 SQL、3,657 字节返回数据，
只产生一个 Fire 和一个 Run，没有读取 Event/Audit/Usage/资源历史。

## 验证与限制

本轮新增 5 项真实 PostgreSQL 回归；本地完整强制验收 **327 通过、0 失败、0 跳过**。
类型检查、构建、Demo 冒烟、vendor 校验、配置检查、脚本语法和差异检查通过。
`npm audit --audit-level=high` 通过（0 high/critical，保留 2 moderate）。CI 结果见 PR 描述。
Compose 空卷挂载 001–013，检查共享/个人 schema **6:11**。
第五轮披露的沙箱维护反向数据分布扫描风险继续保留；本轮不改变该查询。
旧 v9 的 5 分钟/500 SSE/100 Run 数据仍只是历史基线，本轮没有重复该长测。
