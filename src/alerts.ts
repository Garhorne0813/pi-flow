export type Alert = {
  rule: string;
  severity: "warning" | "critical";
  metric: string;
  value: number;
  action: string;
};
// Counter snapshots are cumulative per process. Compare adjacent snapshots;
// a process restart/reset must never create a negative rate or repeat old errors.
export function alerts(
  counters: Record<string, number>,
  previous: Record<string, number> = {},
  unknownCapacity = 0,
): Alert[] {
  const rules = [
    [
      "worker_failure",
      "worker_errors_total",
      "warning",
      "inspect_worker_and_database",
    ],
    [
      "heartbeat_failure",
      "heartbeat_errors_total",
      "warning",
      "inspect_database_and_lease",
    ],
    ["lease_lost", "lease_lost_total", "warning", "inspect_owner_and_clock"],
    [
      "mcp_unknown",
      "mcp_unknown_total",
      "critical",
      "reconcile_remote_outcome_no_replay",
    ],
    [
      "reclaim_failed",
      "sandbox_reclaim_failed_total",
      "warning",
      "inspect_provider_and_retry_cleanup",
    ],
  ] as const;
  const result: Alert[] = rules.flatMap(([rule, metric, severity, action]) => {
    const value = Math.max(
      0,
      (counters[metric] ?? 0) - (previous[metric] ?? 0),
    );
    return value > 0 ? [{ rule, metric, severity, action, value }] : [];
  });
  if (unknownCapacity > 0)
    result.push({
      rule: "sandbox_unknown",
      metric: "sandbox_unknown",
      severity: "critical",
      value: unknownCapacity,
      action: "reconcile_owned_inventory_no_ttl_release",
    });
  return result;
}
