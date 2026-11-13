import { Fault } from "./model.js";
import type { UsageRecord, Policy } from "./usage.js";
// Call only while holding the same per-user lock used by normal Run reservations.
export function checkUsageCaps(
  records: UsageRecord[],
  policy: Policy,
  user: string,
  tokens: number,
  cost: number | null,
) {
  const now = new Date().toISOString();
  for (const [period, tokenCap, costCap] of [
    [now.slice(0, 10), policy.tenantDailyTokens, policy.tenantDailyCostMicros],
    [
      now.slice(0, 7),
      policy.tenantMonthlyTokens,
      policy.tenantMonthlyCostMicros,
    ],
    [now.slice(0, 10), policy.userDailyTokens, policy.userDailyCostMicros],
    [now.slice(0, 7), policy.userMonthlyTokens, policy.userMonthlyCostMicros],
  ] as const) {
    const list = records.filter(
      (r) => r.userId === user && r.at.startsWith(period),
    );
    if (
      tokenCap !== undefined &&
      list.reduce((n, r) => n + r.tokens, 0) + tokens > tokenCap
    )
      throw new Fault(429, "MODEL_BUDGET_EXCEEDED");
    if (costCap !== undefined) {
      if (cost === null || list.some((r) => r.costMicros === null))
        throw new Fault(503, "MODEL_PRICE_REQUIRED");
      if (list.reduce((n, r) => n + (r.costMicros ?? 0), 0) + cost > costCap)
        throw new Fault(429, "MODEL_COST_BUDGET_EXCEEDED");
    }
  }
}
