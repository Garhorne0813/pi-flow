import { alerts } from "./alerts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { Fault } from "./domain.js";
export type Context = {
  tenantId?: string;
  runId?: string;
  workerId?: string;
  requestId?: string;
  callId?: string;
  traceId?: string;
  spanId?: string;
};
const scope = new AsyncLocalStorage<Context>();
export function currentTraceparent() {
  const ctx = scope.getStore();
  return ctx?.traceId && ctx.spanId
    ? `00-${ctx.traceId}-${ctx.spanId}-01`
    : undefined;
}
export const traceContext = (parent?: string): Context => {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(parent ?? "");
  return {
    traceId:
      match && !/^0+$/.test(match[1]!)
        ? match[1]
        : randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
  };
};
export const withContext = <T>(context: Context, fn: () => T) =>
  scope.run({ ...scope.getStore(), ...context }, fn);
export const telemetry = {
  sink: (record: Record<string, unknown>) => {
    process.stdout.write(JSON.stringify(record) + "\n");
  },
  metrics: new Map<string, number>(),
  previousSnapshot: {} as Record<string, number>,
  count(name: string, amount = 1) {
    this.metrics.set(name, (this.metrics.get(name) ?? 0) + amount);
  },
  duration(name: string, ms: number) {
    this.count(name + "_count");
    this.count(name + "_sum_ms", ms);
    for (const bound of [10, 100, 1000, 10000, 60000])
      if (ms <= bound) this.count(name + "_le_" + bound);
  },
  error(operation: string, error: unknown, context: Context = {}) {
    const code =
      error instanceof Fault && /^[A-Z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : "INTERNAL_ERROR";
    this.count("worker_errors_total");
    this.count(operation + "_errors_total");
    if (code === "LEASE_LOST") this.count("lease_lost_total");
    if (code === "MCP_OUTCOME_UNKNOWN") this.count("mcp_unknown_total");
    const merged = { ...scope.getStore(), ...context };
    // Explicit allowlist: never serialize the exception, message, headers or payload.
    const safe = Object.fromEntries(
      [
        "tenantId",
        "runId",
        "workerId",
        "requestId",
        "callId",
        "traceId",
        "spanId",
      ].flatMap((key) => {
        const value = merged[key as keyof Context];
        return typeof value === "string" ? [[key, value.slice(0, 200)]] : [];
      }),
    );
    this.sink({
      level: "error",
      time: new Date().toISOString(),
      operation,
      code,
      ...safe,
    });
  },
  snapshot() {
    return Object.fromEntries(this.metrics);
  },
  publish(workerId: string) {
    const counters = this.snapshot();
    const activeAlerts = alerts(counters, this.previousSnapshot);
    this.previousSnapshot = counters;
    this.sink({
      level: "info",
      time: new Date().toISOString(),
      operation: "metrics_snapshot",
      workerId,
      counters,
      alerts: activeAlerts,
    });
  },
};
