import { z } from "zod";
import { Fault, id, type State, type Run } from "./domain.js";
import { authorizedRun } from "./service.js";
import type { Store } from "./store.js";
const limit = z.number().int().positive().optional();
export const UsagePolicy = z
  .object({
    tenantDailyTokens: limit,
    userDailyTokens: limit,
    tenantMonthlyTokens: limit,
    userMonthlyTokens: limit,
    tenantDailyCostMicros: limit,
    tenantMonthlyCostMicros: limit,
    userDailyCostMicros: limit,
    userMonthlyCostMicros: limit,
    alertRatio: z.number().min(0).max(1).default(0.8),
    prices: z
      .record(
        z.string(),
        z
          .object({
            version: z.string().min(1),
            input: z.number().nonnegative(),
            output: z.number().nonnegative(),
            cacheRead: z.number().nonnegative().default(0),
            cacheWrite: z.number().nonnegative().default(0),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export type Policy = z.infer<typeof UsagePolicy>;
export type ModelUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};
export type UsageRecord = {
  id: string;
  runId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  model: string;
  at: string;
  status: "reserved" | "confirmed" | "unknown";
  estimatedTokens: number;
  tokens: number;
  maxOutputTokens: number;
  estimatedCostMicros: number | null;
  costMicros: number | null;
  pricingVersion: string | null;
  price?: Policy["prices"][string];
  durationMs?: number;
  usage?: ModelUsage;
};
export type ResourceTransition = {
  workspaceId: string;
  sandboxId?: string;
  state: "active" | "paused" | "unknown" | "released";
  at: number;
};
export type UsageState = {
  requests: Record<string, UsageRecord>;
  resources: ResourceTransition[];
};
export function usageState(s: State): UsageState {
  return (s.usage ??= { requests: {}, resources: [] });
}
export function policyFromEnv() {
  return UsagePolicy.parse(JSON.parse(process.env.USAGE_POLICY_JSON ?? "{}"));
}
const cost = (u: ModelUsage, p: Policy["prices"][string]) =>
  Math.ceil(
    u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite,
  );
const total = (records: UsageRecord[], kind: "tokens" | "costMicros") =>
  records.reduce((sum, r) => sum + (r[kind] ?? r.estimatedCostMicros ?? 0), 0);
export class UsageLedger {
  constructor(
    private store: Store,
    readonly policy: Policy = UsagePolicy.parse({}),
  ) {}
  async reserve(
    tenant: string,
    runId: string,
    inputEstimate: number,
    workerId: string,
  ) {
    if (!Number.isSafeInteger(inputEstimate) || inputEstimate < 0)
      throw new Fault(500, "INVALID_USAGE_ESTIMATE");
    return this.store.tx(tenant, (s) => {
      const r = s.runs[runId];
      if (!r || r.lease?.owner !== workerId || r.lease.expires < Date.now())
        throw new Fault(409, "LEASE_LOST");
      const { ses, config } = authorizedRun(s, r),
        ledger = usageState(s),
        now = new Date().toISOString(),
        records = Object.values(ledger.requests),
        model = config.model.provider + "/" + config.model.modelId,
        price = this.policy.prices[model];
      let root = r;
      const seen = new Set<string>();
      while (root.parentRunId) {
        if (seen.has(root.id)) throw new Fault(403, "INVALID_RUN_TREE");
        seen.add(root.id);
        root = s.runs[root.parentRunId]!;
      }
      const family = (candidate: Run) => {
        let parent = candidate;
        const visited = new Set<string>();
        while (parent.parentRunId) {
          if (visited.has(parent.id)) return false;
          visited.add(parent.id);
          const next = s.runs[parent.parentRunId];
          if (!next) return false;
          parent = next;
        }
        return parent.id === root.id;
      };
      const runUsed = records
          .filter((x) => x.runId === r.id)
          .reduce((n, x) => n + x.tokens, 0),
        familyUsed = records
          .filter((x) => s.runs[x.runId] && family(s.runs[x.runId]!))
          .reduce((n, x) => n + x.tokens, 0),
        rootConfig =
          root.capabilities ??
          s.agents[s.sessions[root.sessionId]!.agentVersionId]!.config;
      let maxOutputTokens = Math.min(
        4096,
        config.maxTokens - Math.max(runUsed, r.tokens ?? 0) - inputEstimate,
        rootConfig.maxTokens -
          Math.max(familyUsed, root.tokens ?? 0) -
          inputEstimate,
      );
      const day = records.filter((x) => x.at.slice(0, 10) === now.slice(0, 10)),
        month = records.filter((x) => x.at.slice(0, 7) === now.slice(0, 7));
      for (const [list, cap] of [
        [day, this.policy.tenantDailyTokens],
        [
          day.filter((x) => x.userId === r.actor.userId),
          this.policy.userDailyTokens,
        ],
        [month, this.policy.tenantMonthlyTokens],
        [
          month.filter((x) => x.userId === r.actor.userId),
          this.policy.userMonthlyTokens,
        ],
      ] as const)
        if (cap !== undefined)
          maxOutputTokens = Math.min(
            maxOutputTokens,
            cap - total(list, "tokens") - inputEstimate,
          );
      if (maxOutputTokens < 1) throw new Fault(429, "MODEL_BUDGET_EXCEEDED");
      const estimate: ModelUsage = {
        input: inputEstimate,
        output: maxOutputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: inputEstimate + maxOutputTokens,
      };
      let estimatedCost = price ? cost(estimate, price) : null;
      for (const [list, cap] of [
        [day, this.policy.tenantDailyCostMicros],
        [month, this.policy.tenantMonthlyCostMicros],
        [
          day.filter((x) => x.userId === r.actor.userId),
          this.policy.userDailyCostMicros,
        ],
        [
          month.filter((x) => x.userId === r.actor.userId),
          this.policy.userMonthlyCostMicros,
        ],
      ] as const) {
        if (cap === undefined) continue;
        if (!price || list.some((x) => x.costMicros === null))
          throw new Fault(503, "MODEL_PRICE_REQUIRED");
        const remaining =
          cap -
          total(list, "costMicros") -
          cost({ ...estimate, output: 0 }, price);
        if (remaining < 0) throw new Fault(429, "MODEL_COST_BUDGET_EXCEEDED");
        if (price.output > 0)
          maxOutputTokens = Math.min(
            maxOutputTokens,
            Math.floor(remaining / price.output),
          );
      }
      if (maxOutputTokens < 1)
        throw new Fault(429, "MODEL_COST_BUDGET_EXCEEDED");
      estimate.output = maxOutputTokens;
      estimate.totalTokens = inputEstimate + maxOutputTokens;
      estimatedCost = price ? cost(estimate, price) : null;
      const record: UsageRecord = {
        id: id(),
        runId: r.id,
        userId: r.actor.userId,
        workspaceId: ses.workspaceId,
        agentId: ses.agentVersionId,
        model,
        at: now,
        status: "reserved",
        estimatedTokens: estimate.totalTokens,
        tokens: estimate.totalTokens,
        maxOutputTokens,
        estimatedCostMicros: estimatedCost,
        costMicros: estimatedCost,
        pricingVersion: price?.version ?? null,
        price: price ? structuredClone(price) : undefined,
      };
      ledger.requests[record.id] = record;
      return { id: record.id, maxOutputTokens };
    });
  }
  async settle(
    tenant: string,
    requestId: string,
    usage: ModelUsage | undefined,
    durationMs: number,
  ) {
    await this.store.tx(tenant, (s) => {
      const r = usageState(s).requests[requestId];
      if (!r) throw new Fault(404, "USAGE_REQUEST_NOT_FOUND");
      if (r.status === "confirmed") return;
      r.durationMs = Math.max(0, durationMs);
      const valid =
        usage &&
        Object.values(usage).every((v) => Number.isSafeInteger(v) && v >= 0) &&
        usage.totalTokens > 0;
      if (!valid) {
        r.status = "unknown";
        return;
      }
      r.status = "confirmed";
      r.usage = usage;
      r.tokens = Math.max(
        usage.totalTokens,
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      );
      const price = r.price;
      r.costMicros =
        price && price.version === r.pricingVersion ? cost(usage, price) : null;
    });
  }
}
export function resourceTransitions(before: State, after: State) {
  for (const [workspaceId, w] of Object.entries(after.workspaces)) {
    const old = before.workspaces[workspaceId];
    if (old?.sandboxId === w.sandboxId && old?.sandboxState === w.sandboxState)
      continue;
    if (
      !old?.sandboxId &&
      !old?.sandboxState &&
      !w.sandboxId &&
      !w.sandboxState
    )
      continue;
    usageState(after).resources.push({
      workspaceId,
      sandboxId: w.sandboxId ?? old?.sandboxId,
      state: w.sandboxState ?? (w.sandboxId ? "active" : "released"),
      at: Date.now(),
    });
  }
}
export function usageReport(
  s: State,
  policy: Policy,
  userId?: string,
  runId?: string,
) {
  const records = Object.values(s.usage?.requests ?? {}).filter(
    (r) => (!userId || r.userId === userId) && (!runId || r.runId === runId),
  );
  const tokens = total(records, "tokens"),
    costMicros = records.some((r) => r.costMicros === null)
      ? null
      : total(records, "costMicros");
  const resources = (s.usage?.resources ?? []).filter(
    (r) =>
      (!userId || s.workspaces[r.workspaceId]?.ownerId === userId) &&
      (!runId ||
        r.workspaceId ===
          s.sessions[s.runs[runId]?.sessionId ?? ""]?.workspaceId),
  );
  const sandbox = {
    activeMs: 0,
    pausedMs: 0,
    unknownMs: 0,
    observedCreates: 0,
  };
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i]!,
      next = resources
        .slice(i + 1)
        .find((x) => x.workspaceId === r.workspaceId);
    const duration = Math.max(0, (next?.at ?? Date.now()) - r.at);
    if (r.state === "active") sandbox.activeMs += duration;
    if (r.state === "paused") sandbox.pausedMs += duration;
    if (r.state === "unknown") sandbox.unknownMs += duration;
    if (
      r.state === "active" &&
      !resources
        .slice(0, i)
        .some(
          (x) => x.workspaceId === r.workspaceId && x.sandboxId === r.sandboxId,
        )
    )
      sandbox.observedCreates++;
  }
  const budgetWarnings: {
    scope: "tenant" | "user";
    userId?: string;
    period: "day" | "month";
    dimension: "tokens" | "costMicros";
    used: number;
    limit: number;
  }[] = [];
  const warn = (
    scope: "tenant" | "user",
    list: UsageRecord[],
    owner?: string,
  ) => {
    const now = new Date().toISOString();
    for (const period of ["day", "month"] as const) {
      const recent = list.filter(
        (r) =>
          r.at.slice(0, period === "day" ? 10 : 7) ===
          now.slice(0, period === "day" ? 10 : 7),
      );
      for (const dimension of ["tokens", "costMicros"] as const) {
        const key =
          `${scope}${period === "day" ? "Daily" : "Monthly"}${dimension === "tokens" ? "Tokens" : "CostMicros"}` as keyof Policy;
        const cap = policy[key];
        if (
          typeof cap !== "number" ||
          (dimension === "costMicros" &&
            recent.some((r) => r.costMicros === null))
        )
          continue;
        const used = total(recent, dimension);
        if (used >= cap * policy.alertRatio)
          budgetWarnings.push({
            scope,
            userId: owner,
            period,
            dimension,
            used,
            limit: cap,
          });
      }
    }
  };
  if (!runId) {
    if (!userId) warn("tenant", records);
    for (const owner of new Set(records.map((r) => r.userId)))
      warn(
        "user",
        records.filter((r) => r.userId === owner),
        owner,
      );
  }
  return {
    records,
    tokens,
    costMicros,
    costIsEstimate: true,
    billingTimezone: "UTC",
    requestCount: records.length,
    unknownRequests: records.filter((r) => r.status !== "confirmed").length,
    budgetWarnings,
    sandbox,
    nearDailyBudget:
      policy.tenantDailyTokens !== undefined &&
      total(
        records.filter(
          (r) => r.at.slice(0, 10) === new Date().toISOString().slice(0, 10),
        ),
        "tokens",
      ) >=
        policy.tenantDailyTokens * policy.alertRatio,
  };
}
