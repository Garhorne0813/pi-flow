# 健康检查与部署

`GET /health` 和 `/health/live` 保持匿名兼容，只表示 API 进程能够响应。
`GET /health/ready` 匿名检查数据库和预期 schema 版本，1 秒内未完成或版本不符
返回 503，只返回 ready/not_ready，不返回数据库地址、凭证或租户详情。
启动配置仍由 bootstrap 校验，配置无效不会监听端口。先执行 npm run migrate；
既有部署也须重新执行幂等迁移，创建 harness_schema 和 harness_worker_health。

`GET /api/v1/admin/health/workers` 要求管理员身份，返回独立持久 Worker 心跳、
最后成功 tick、最后领取时间、在途任务数、maintenance 状态和 stopping。
每个 Worker 最多每 5 秒发布一次，15 秒内没有成功 tick 的 Worker 不算健康；
没有健康 Worker 时返回 503。API readiness 不依赖 Worker，以便故障期间读取状态。
该接口不返回任务内容或租户资源。监控应对 no_healthy_worker、maintenance=failed、
stale=true 告警；队列有待处理 Run 而 lastClaimAt 长时间不更新时检查容量与领取。
过期 Worker 行保留 1 天的查询窗口；运维可定期删除更旧记录。

Kubernetes API 示例（端口名 http 指向 8080）：

```yaml
startupProbe:
  httpGet: {path: /health/live, port: http}
  periodSeconds: 2
  failureThreshold: 30
livenessProbe:
  httpGet: {path: /health/live, port: http}
  periodSeconds: 10
  timeoutSeconds: 2
readinessProbe:
  httpGet: {path: /health/ready, port: http}
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 2
terminationGracePeriodSeconds: 30
```

API 默认请求超时 30 秒，SSE 是长连接：代理应关闭缓冲，并给出较长读超时，
客户端按事件 ID 重连。SIGTERM 停止 Worker 领取、取消并等待在途任务（默认上限
5 秒），然后关闭 API 和数据库；未确认的远端结果保持 unknown，不重放。
独立 Worker 不能用 API liveness 判断，监控上述共享心跳；Worker 停止时会发布
stopping。数据库故障只应撤下 API readiness，不能用它重启仍存活的 API。

组合运行时要求迁移 001–004；readiness 同时检查归一化 Run、Session、事件序列与容量表。仅执行 001 不会接受流量。
