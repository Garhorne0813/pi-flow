import { Fault, terminal, type Workspace, type State } from "../domain.js";
export function assertLifecycleAvailable(
  s: State,
  w: Workspace,
  options: { cutoff?: number; allRuns?: boolean },
  now = Date.now(),
) {
  if (
    (w.lock && w.lock.expires > now) ||
    (w.fileLock && w.fileLock.expires > now)
  )
    throw new Fault(409, "WORKSPACE_BUSY");
  if (
    options.cutoff !== undefined &&
    (w.sandboxLastUsedAt ?? now) > options.cutoff
  )
    throw new Fault(409, "SANDBOX_NOT_IDLE");
  if (
    Object.values(s.runs).some(
      (r) =>
        s.sessions[r.sessionId]?.workspaceId === w.id &&
        (options.allRuns
          ? !terminal(r.state)
          : ["QUEUED", "RUNNING"].includes(r.state)),
    )
  )
    throw new Fault(409, "ACTIVE_RUNS");
}
export function assertLease(w: Workspace, owner: string, now = Date.now()) {
  if (w.lock?.owner !== owner || w.lock.expires < now)
    throw new Fault(409, "LEASE_LOST");
}
