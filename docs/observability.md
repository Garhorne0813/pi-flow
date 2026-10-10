# Worker 可观察性

错误日志是 JSON，包含 operation、稳定 error code 和可用的 tenantId/runId/
workerId/requestId/callId/traceId/spanId。异常 message、stack、Prompt、Tool args/
result、Authorization 和 Endpoint credentials 不会序列化。同步队列中的 catch
只消化已记录的拒绝，不重试工具；Worker tick 失败记录后继续轮询，在途未知结果
仍 FAILED/unknown，不自动重放。

Worker 每 5 秒将进程 counters 作为 metrics_snapshot JSON 输出，日志采集器应将
其转为各进程的累计指标（按 worker/进程去重，不能把每个快照当增量相加）。
独立 Worker 的指标来自该进程 stdout，不会错误地出现在 API 的内存计数中。
管理员 /api/v1/admin/metrics 返回当前 API 进程 counters 和共享数据库的容量状态
汇总；不返回 Sandbox ID 或其他租户的明细。API 模式独立于 Worker 模式。

指标：worker_errors_total、各 operation_errors_total、heartbeat_errors_total、
lease_lost_total、mcp_unknown_total、sandbox_reclaim_failed_total、sse_active。
run_queue/run/model 包含 count、sum_ms 和 10/100/1000/10000/60000ms 累计桶；
model 是完整 Runtime 执行耗时，包含工具/检查点等待，不能作为纯网关延迟。
容量状态汇总含 reserved/unknown/active/paused/released；unknown 不能按 TTL 释放。

建议采集后配置：
- heartbeat_errors_total / worker_tick_errors_total 5 分钟持续增长：warning，检查 DB。
- mcp_unknown_total 新增或 sandbox unknown > 0：critical，人工核对远端结果，禁止重放。
- sandbox_reclaim_failed_total 新增：warning；unknown 连续 15 分钟不下降升级 critical。
- lease_lost_total 新增：warning，检查暂停/时钟/进程状态。
- run_queue 的 P95 超过部署 SLO：warning；联查 Worker 心跳与容量。

API 接收合法 W3C traceparent，持久化至 Run；Worker 从中创建新 span，并通过
AsyncLocalStorage 保持 Runtime/Sandbox/MCP 异步日志关联，MCP _meta 携带 traceparent。
不接受自定义 trace 属性或 baggage。上下文格式兼容 OpenTelemetry；本仓库不内置
外部 OTel Collector/exporter，应在部署日志采集配置中绑定 trace_id/span_id。
数据库事件仍以 requestId/runId/callId 关联；不把敏感执行输出复制进 trace。

`src/alerts.ts` 是可执行告警规则：Worker 快照比较相邻累计计数，只报告新增错误；重启导致计数下降不触发告警。MCP unknown 和 API 查询到的 unknown 容量为 critical；心跳、租约、回收和 Worker 异常为 warning。`metrics_snapshot.alerts` 与 `/api/v1/admin/metrics.alerts` 返回稳定规则名、指标、数量和处理动作，不包含执行数据。部署采集器需将这些告警接入通知渠道；本次未配置外部通知。
