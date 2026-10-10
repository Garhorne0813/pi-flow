# 持久事件与流控

依赖 #11 的 event 表与序列表。Worker 的单 Run emit 使用 runTx，只追加独立事件，
不更新租户 JSON。delta 默认每 50ms 或 4096 字符成批；最多 131072 字符待写，
超出显式失败 STREAM_BACKPRESSURE_LIMIT，不静默丢弃或积累无界 Promise。
message.completed、工具/问答/终态之前先等待所有已接收 delta 刷盘，消息内容不变。
批量后 event ID 表示批而非每个 token，不承诺原始 token 分片粒度。

SSE 每页按 (tenant_id,run_id,event_id) 索引读取最多 100 条，同一只读快照检查 ACL。
Worker COMMIT 时 NOTIFY 唤醒订阅；每个 Store 复用一条 LISTEN 连接。通知无载荷消息，
只包含内部 tenant/run 关联键，不能替代持久日志。遗漏/断开的通知由 250ms 有界轮询
兜底，Last-Event-ID 回放仍有序。断连 AbortSignal 清理通知/定时器监听，背压时等待
socket drain/close，不发无界数据。JWT 到期处理由独立 #16 修复提供。

数据库保留了事件全文与会话检查点，不能删 message.completed 或 final Session history。
生产 retention 应先归档并记录已归档 event ID 区间，再按业务合规周期清理终态 Run；
当前没有自动删历史逻辑，以免破坏回放。read() 管理查询仍可载入完整历史，SSE 与
单 Run append/心跳使用有界专用路径，不通过清理历史掩盖写放大。

测试包括 Unicode 拼接、批大小/待写上限、持久化失败、完成前刷新，真实 PostgreSQL
分页/跨客户端通知/取消订阅/跨租户隔离，以及原有 SSE ACL 回放。生产压测应记录
长会话写入、10/100/500 订阅、Run 心跳 P95/P99、WAL、锁等待、内存，不能把本地
通过当作 500 连接容量承诺；压测入口和结果口径见 #18。

## 已完成阶段与生产结论

[PR #33](https://github.com/Garhorne0813/pi-flow/pull/33) 的 10/100/500 客户端测试
使用真实 HTTP 和 PostgreSQL、一个热 Run 及 20 个合成事件，证明该场景下有序回放
与重连正确，并记录环境相关延迟/CPU/RSS。它不验证实际模型 delta 速率、长会话、
多 Run 混合负载或生产 SLO。事件页数量有界不等于所有授权元数据和管理 read() 都
已归一化或开销恒定；#11 普通跨实体事务的租户锁仍存在。生产负载证据独立由
[#18](https://github.com/Garhorne0813/pi-flow/issues/18) 和
[真实网关 #37](https://github.com/Garhorne0813/pi-flow/issues/37) 跟踪。
