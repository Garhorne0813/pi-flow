import { Fault, audit, type Actor } from "./domain.js";
import type { Store } from "./store.js";
import type { SandboxManager } from "./adapters/sandbox.js";
export class SandboxReconciler {
  constructor(
    private store: Store,
    private sandbox: SandboxManager,
  ) {}
  async scan(tenant?: string) {
    const report = { examined: 0, reclaimed: 0, unresolved: 0, failed: 0 };
    const assets = await this.sandbox.inventory();
    const entries = await this.store.capacityRead((s) =>
      Object.values(s.entries).filter((e) => !tenant || e.tenantId === tenant),
    );
    for (const entry of entries) {
      if (!["reserved", "unknown"].includes(entry.state)) continue;
      report.examined++;
      const candidates = assets.filter((a) =>
        entry.sandboxId
          ? a.sandboxId === entry.sandboxId
          : a.operation === entry.operation,
      );
      let outcome = "IDENTITY_UNCONFIRMED";
      if (candidates.length === 1) {
        try {
          await this.sandbox.reconcileOrphan(entry, candidates[0]!);
          report.reclaimed++;
          outcome = "RECLAIMED";
        } catch (e) {
          report.failed++;
          outcome = e instanceof Fault ? e.code : "RECONCILE_FAILED";
        }
      } else report.unresolved++;
      const actor: Actor = {
        tenantId: entry.tenantId,
        userId: entry.userId,
        admin: false,
      };
      await this.store.tx(entry.tenantId, (s) =>
        audit(s, actor, "sandbox.reconcile.scan", entry.workspaceId, outcome),
      );
    }
    // The v1 SDK enumerates running instances only; absence is NOT evidence
    // that a paused/creating instance doesn't exist. Never release by TTL.
    return report;
  }
}
