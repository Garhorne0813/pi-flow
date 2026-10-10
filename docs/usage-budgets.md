# 模型用量与预算

USAGE_POLICY_JSON 是部署端配置，API 客户端/模型不能设置价格和账本。例：

```json
{"tenantDailyTokens":1000000,"tenantMonthlyTokens":20000000,"userDailyTokens":200000,"userMonthlyTokens":4000000,"tenantDailyCostMicros":2000000,"tenantMonthlyCostMicros":30000000,"alertRatio":0.8,"prices":{"gateway/model":{"version":"2026-10","input":0.5,"output":2,"cacheRead":0.1,"cacheWrite":0.5}}}
```

价格单位 USD/百万 tokens；费用以整数 micro-USD 向上取整，1000000 micro-USD=$1。
日/月账期固定 UTC。价格版本与当时价格快照随请求持久化，之后配置变动不会改历史。
没有报价时成本是 null，不能把 Pi 自定义模型的 cost=0 当免费；设置成本预算但无报价
则请求前拒绝 MODEL_PRICE_REQUIRED。所有 Worker 必须部署相同 policy/价格版本。

Pi streamFunction 包装器在真正网关派发前原子预留每次请求，输入按请求上下文 UTF-8
字节/3 估算，输出根据 Run/祖先、租户、用户剩余额度和4096上限共同约束，再设置真实
请求 maxTokens。账本位于共享 Store 持久事务，不靠单进程计数；子 Agent 计入根 Run。
实际 usage 返回后结算 input/output/cache、请求数、耗时和模型维度；缺失、负数或全零
usage 保留 reserved/unknown 估算占额，不能按超时直接退回。实际 usage 超过预估会计入
真实报告并阻止后续请求，不能保证单次绝不超支。最终供应商账单、tokenizer差异、网关
汇率/折扣/缓存定义均可能造成误差；这里提供预算控制和成本估算，不是结算发票。

GET /api/v1/usage 返回自身记录；GET /api/v1/runs/:id/usage 检查 Run ACL；管理员
GET /api/v1/admin/usage 汇总当前租户，包含 nearDailyBudget，采集器可在80%/100%
阈值告警。各项记录带 user/workspace/agent/run/model，不暴露其他租户、Prompt 或密钥。
reserved/unknown 需人工用网关 request 记录核验，重复 confirmed settlement 不重复计费。

Sandbox 报告统计数据库观察到的 Workspace active/paused/unknown 区间与创建数，重复
写入同状态不重复记录，未知时长单列。不是供应商账单，不将未知容量解释为真实费用；
临时文件实例和外部孤儿的完整成本需接供应商资源账单，目前覆盖范围仅 Workspace
生命周期观察。老实例历史无法补推，只有升级后观察。账本目前仍在租户 JSON 聚合，
后续可拆表但必须保留同等并发额度协议，不允许各 Worker 本地独立预算。

用户也可配置 `userDailyCostMicros` / `userMonthlyCostMicros`。`budgetWarnings` 以 UTC 日/月窗口报告租户/用户 token 与费用接近阈值，管理员仅看到本租户，用户仅看到自己，单 Run 报告不计算整个用户预算。`requestCount` 和 `unknownRequests` 区分请求数量与未确认用量；配额汇总仍使用 `/api/v1/sandbox-capacity`。Run 的 Sandbox 时长是其所属 Workspace 的观察区间，不表示该 Run 独占或供应商费用。
