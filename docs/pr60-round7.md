# PR #60 第七轮：控制面事务、审计分页与手动 Memory

基于 `85137b9` 修复四条遗留全历史读取路径。新增
`014_personal_control_paths.sql`，个人 schema **v12**，共享 schema 仍为 v6。
停止旧 API/Worker，顺序执行全部迁移后启动；Compose 挂载 001–014 并检查 6:12。
readiness 同时验证新增的两个索引有效且属于正确表。

## 取消与续跑

`cancelTaskTx` 和 `interactionTx` 复用 executionTx 的原子保存机制。
取得用户元数据锁后，只加载任务链的 Run、相关 Session 摘要和授权工作区；
平台实时配置在取得锁后叠加。取消更新未终结成员，运行中 Run 设置
cancelRequested，其他成员立即取消并追加事件/审计。不会加载历史 Event、
Audit、Usage 或 Schedule，事件编号继续由独立计数器分配。

Interaction 通过 ID 从用户 JSONB 中直接定位，再锁定关联任务链和 Session，
并检查该 Session 的其他未完成 Run。只读取目标 Interaction，幂等重试也读取
该任务链中既有的 continuation。Token 刷新、Interaction 解决、原 Run 完成、
创建 continuation 及事件/审计在同一事务中提交；失败整体回滚。
Session entries 不参与续跑创建，因此不加载 transcript。

任务身份查询使用 COALESCE(taskId, rootRunId, run_id) 的新表达式索引，覆盖
旧快照只有 rootRunId 的记录。正常任务链大小仍决定其读取量；不是固定行数
的单 Run 更新。用户元数据与 Interaction 仍存 JSONB，数据库内部 TOAST/字段
提取成本及同用户锁等待仍然存在，本轮不声称这些成本消失。

真实 HTTP 与 PostgreSQL 回归：

- 取消同一个目标在空历史与 5,000 Run / 50,000 个 1 KiB Event、各 5,000
  Audit/Usage/Fire 下均为 15 条 SQL，返回数据分别 2,802 / 2,880 字节。
  一次本地请求为 52.3 / 11.3ms（包含首次路由/连接开销，不能当作 P95 或 SLA）。
- 同规模历史下，两次并发审批响应共 31 条 SQL、11,718 字节，返回同一
  continuation；本地两请求完成约 52.5ms。验证旧 Actor 过期后刷新密封 Token、
  保留配置快照、重复响应不改写已接受凭证、冲突响应拒绝及无 Token 回滚。
- 验证跨客户端并发取消只为每个未运行成员产生一次取消事件，保留终态成员；
  包含无 taskId、只有 rootRunId 的旧链成员。验证等待 checkpoint、Agent 实时
  禁用、与新 Run admission 竞争、审批/提问与取消竞争及跨用户拒绝访问。
- 既有真实 Worker 刷新凭证后执行 bash 的回归继续运行。

额外 EXPLAIN ANALYZE 验证取消任务链查询使用 personal_runs_task_identity 索引。
返回字节为 SQL 行的 JSON 序列化大小，不是数据库内部页读取量。

## 审计分页

`GET /api/v1/admin/audit` 在 PostgreSQL 使用独立表直接 LIMIT/OFFSET，保留
旧 offset 参数，新增可选 cursor/nextCursor。按 timestamp/id 升序稳定排序，
与原 PostgreSQL 读取方向一致；游标使用相同二元组，拒绝非法游标及非零 offset
与 cursor 混用。每页最多预读一行判断下一页。共享/内存实现只读取 audit 元数据。

5,000 审计和大量无关执行历史下，limit=2 每页仅返回 3 条审计行，每次含身份
SELECT 共 2 条 SQL、561–1,512 字节。回归覆盖同时间戳、页间插入、offset
兼容、租户隔离及非管理员拒绝；EXPLAIN ANALYZE 验证使用 personal_audit_page，
没有额外 Sort。深 offset 仍需跳过索引项，大列表连续翻页应使用 cursor。

## 手动 Memory

无额外授权回调的手动写入直接 appendAudit，分别记录 attempt 与 success/failed，
不占用 Run 写入配额。沙箱 mkdir/find/read/write 也复用文件 API 的工作区范围
事务，避免嵌套租约、生命周期和清理路径回退到全历史读写，保留活动 Run 排他检查。
有授权回调的手动操作仍在工作区事务内执行回调。

大历史量下成功和沙箱写失败的真实 HTTP 回归均通过；测试直接使通用 tx() 抛错，
确认整条路径不依赖它。验证两次 attempt、一次成功、一次失败审计及持久文件读取。
成功路径采样 496 条 SQL / 48,799 字节，失败路径 450 条 / 50,193 字节；这些是
多个沙箱步骤及其生命周期检查的总计，并未宣称调用次数很少。两条审计是独立
追加，远程文件和数据库审计不是分布式事务，写文件后审计持久化失败的边界仍存在。

## 验证

新增 5 项真实 PostgreSQL 回归；本地完整强制验收 **332 通过、0 失败、0 跳过**，
额外的取消查询执行计划回归通过。类型检查、构建、Demo 冒烟、vendor、配置检查、
Prettier、脚本语法及差异检查通过；npm audit 无 high/critical，保留 2 moderate。
当前提交 CI 结果见 PR 描述。
本轮不重复 v9 的 5 分钟/500 SSE/100 Run 长测；第五轮沙箱维护反向分布的扫描
风险继续保留。
