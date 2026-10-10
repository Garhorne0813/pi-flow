# 可执行预算控制与可审计成本估算

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
用量/估算报告并阻止后续请求，不能保证单次绝不超支。最终供应商账单、tokenizer差异、网关
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

## #19 的验收范围

验收目标是 **可执行预算控制 + 可审计的成本估算**：在共享持久事务内完成请求前
预留和预算拒绝；可信网关 usage 返回后核算 tokens；保留服务端价格、版本、请求
状态与误差来源；报告按租户/Run 授权隔离。账本中的 confirmed 表示可信 usage 已
记录，不表示供应商已出账、付款或财务对账完成。

| 数据 | 本实现的含义 | 费用边界 |
| --- | --- | --- |
| 请求前输入 tokens | UTF-8 字节/3 的估算 | 不能保证 tokenizer 或单次账单精确 |
| reserved/unknown 请求 | 保守预留并持续占用估算额度 | 未知不是免费，也不能断言已产生等额费用 |
| confirmed usage + 价格快照 | 可追溯的用量与版本化成本估算 | 与折扣、税费、汇率、缓存计价或最终账单可能不同 |
| Sandbox active/paused/unknown 时间 | 数据库观察到的 Workspace 生命周期区间 | 不等于供应商收费时长或资源账单 |

Pi SDK + 本地 HTTP 网关的合约与失真测试是阶段成果；部署端真实网关集成由
[#37](https://github.com/Garhorne0813/pi-flow/issues/37) / #18 验收。
财务级结算独立由 [#38](https://github.com/Garhorne0813/pi-flow/issues/38) 跟踪，
需要实际提供商账单导入、幂等匹配、差异/冲销审计和金额核验。本次未实现账单对账，
该后续任务不作为 #19 预算控制与估算审计的关闭条件，也不据此声称准确供应商结算。

## Reproducible protocol usage example

The real local HTTP gateway in test/pi-contract.test.ts returns an OpenAI-compatible
SSE usage frame: {"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}.
Pi normalizes this response into trusted request usage; the contract verifies
request output limits and refusal before dispatch. This is a protocol fixture,
not an enterprise deployment capture. test/usage.test.ts covers missing/zero/invalid
usage, repeated settlement and shared PostgreSQL budgets. Actual deployment
usage, cache semantics and fault evidence remain release gates in #37/#18.
