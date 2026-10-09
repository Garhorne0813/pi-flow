import { z } from "zod";
import { Fault, type Actor, type Workspace } from "../domain.js";
import type { Store } from "../store.js";

export const SandboxPolicySchema = z
  .object({
    maxActivePerUser: z.number().int().min(1).default(3),
    maxActiveTotal: z.number().int().min(1).default(100),
    idlePauseSeconds: z.number().int().min(1).default(900),
    idleReleaseSeconds: z.number().int().min(1).default(86400),
    sweepIntervalSeconds: z.number().int().min(1).default(60),
    maxSnapshotsPerWorkspace: z.number().int().min(1).default(20),
  })
  .strict()
  .refine(
    (p) => p.idleReleaseSeconds >= p.idlePauseSeconds,
    "Release timeout must not precede pause timeout",
  );
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;
export type CapacityEntry = {
  tenantId: string;
  workspaceId: string;
  userId: string;
  state: "reserved" | "active" | "paused" | "unknown" | "released";
  sandboxId?: string;
  operation?: string;
  updatedAt: number;
};
export type CapacityState = { entries: Record<string, CapacityEntry> };
const key = (tenant: string, wid: string) => JSON.stringify([tenant, wid]);
const charged = (entry: CapacityEntry) =>
  ["reserved", "active", "unknown"].includes(entry.state);

export class SandboxCapacity {
  private adoption?: Promise<void>;
  constructor(
    private store: Store,
    readonly policy: SandboxPolicy,
  ) {}
  async orphan(
    a: Actor,
    wid: string,
    operation: string,
    sandboxId: string,
    userId: string,
  ) {
    await this.store.capacityTx((s) => {
      const orphanId = `${wid}:orphan:${operation}`;
      s.entries[key(a.tenantId, orphanId)] = {
        tenantId: a.tenantId,
        workspaceId: orphanId,
        userId,
        operation,
        sandboxId,
        state: "unknown",
        updatedAt: Date.now(),
      };
    });
  }
  adoptLegacy() {
    return (this.adoption ??= (async () => {
      for (const tenant of await this.store.tenants()) {
        const workspaces = await this.store.read(tenant, (s) =>
          Object.values(s.workspaces).filter((w) => w.sandboxId),
        );
        await this.store.capacityTx((s) => {
          for (const w of workspaces) {
            const k = key(tenant, w.id);
            s.entries[k] ??= {
              tenantId: tenant,
              workspaceId: w.id,
              userId: w.ownerId,
              sandboxId: w.sandboxId,
              state: w.sandboxState ?? "active",
              updatedAt: Date.now(),
            };
          }
        });
      }
    })());
  }
  async reserve(
    tenant: string,
    w: Workspace,
    operation: string,
    expected: CapacityEntry | undefined,
  ) {
    await this.adoptLegacy();
    await this.store.capacityTx((s) => {
      const k = key(tenant, w.id),
        old = s.entries[k];
      if (!this.matches(old, expected))
        throw new Fault(409, "CAPACITY_LEASE_LOST");
      if (old && old.state !== "released" && old.sandboxId !== w.sandboxId)
        throw new Fault(409, "CAPACITY_LEASE_LOST");
      if (old && ["reserved", "unknown"].includes(old.state))
        throw new Fault(409, "SANDBOX_OUTCOME_UNKNOWN");
      if (!old || !charged(old)) {
        const entries = Object.values(s.entries).filter(charged);
        if (
          entries.filter((e) => e.tenantId === tenant && e.userId === w.ownerId)
            .length >= this.policy.maxActivePerUser
        )
          throw new Fault(429, "USER_SANDBOX_LIMIT");
        if (entries.length >= this.policy.maxActiveTotal)
          throw new Fault(429, "GLOBAL_SANDBOX_LIMIT");
      }
      s.entries[k] = {
        tenantId: tenant,
        workspaceId: w.id,
        userId: w.ownerId,
        state: "reserved",
        sandboxId: w.sandboxId,
        operation,
        updatedAt: Date.now(),
      };
    });
  }
  async active(
    tenant: string,
    wid: string,
    operation: string,
    sandboxId: string,
  ) {
    await this.store.capacityTx((s) => {
      const e = s.entries[key(tenant, wid)];
      if (!e || e.operation !== operation || e.state === "released")
        throw new Fault(409, "CAPACITY_LEASE_LOST");
      e.state = "active";
      e.sandboxId = sandboxId;
      e.updatedAt = Date.now();
    });
  }
  async pending(
    tenant: string,
    wid: string,
    operation: string,
    sandboxId?: string,
  ) {
    await this.store.capacityTx((s) => {
      const e = s.entries[key(tenant, wid)];
      if (!e || e.operation !== operation || e.state === "released")
        throw new Fault(409, "CAPACITY_LEASE_LOST");
      e.state = "reserved";
      if (sandboxId) e.sandboxId = sandboxId;
      else delete e.sandboxId;
    });
  }
  async unknown(
    tenant: string,
    wid: string,
    operation: string,
    sandboxId?: string,
  ) {
    return this.store.capacityTx((s) => {
      const e = s.entries[key(tenant, wid)];
      if (e && e.operation === operation && e.state !== "released") {
        e.state = "unknown";
        e.sandboxId = sandboxId ?? e.sandboxId;
        e.updatedAt = Date.now();
        return true;
      }
      return false;
    });
  }
  async paused(tenant: string, wid: string, operation: string) {
    return this.store.capacityTx((s) => {
      const e = s.entries[key(tenant, wid)];
      if (e && e.operation === operation && e.state !== "released") {
        e.state = "paused";
        e.updatedAt = Date.now();
        return true;
      }
      return false;
    });
  }
  async released(tenant: string, wid: string, operation: string) {
    return this.store.capacityTx((s) => {
      const e = s.entries[key(tenant, wid)];
      if (e && e.operation === operation && e.state !== "released") {
        e.state = "released";
        delete e.sandboxId;
        e.updatedAt = Date.now();
        return true;
      }
      return false;
    });
  }
  private matches(
    current: CapacityEntry | undefined,
    expected: CapacityEntry | undefined,
  ) {
    return (
      current?.operation === expected?.operation &&
      current?.sandboxId === expected?.sandboxId &&
      current?.state === expected?.state &&
      current?.updatedAt === expected?.updatedAt
    );
  }
  // A control-plane operation takes ownership before touching a remote instance.
  async claim(
    tenant: string,
    wid: string,
    expected: CapacityEntry,
    operation: string,
  ) {
    await this.store.capacityTx((s) => {
      const entry = s.entries[key(tenant, wid)];
      if (
        !this.matches(entry, expected) ||
        !entry ||
        entry.state === "released"
      )
        throw new Fault(409, "CAPACITY_LEASE_LOST");
      entry.operation = operation;
      entry.state = "reserved";
      entry.updatedAt = Date.now();
    });
  }
  async inspect(tenant: string, wid: string) {
    return this.store.capacityRead((s) => s.entries[key(tenant, wid)]);
  }
  async get(tenant: string, wid: string) {
    const entry = await this.inspect(tenant, wid);
    return entry?.state === "released" ? undefined : entry;
  }
  async usage(a: Actor) {
    await this.adoptLegacy();
    return this.store.capacityRead((s) => {
      const entries = Object.values(s.entries);
      return {
        policy: this.policy,
        user: {
          active: entries.filter(
            (e) =>
              charged(e) && e.tenantId === a.tenantId && e.userId === a.userId,
          ).length,
          paused: entries.filter(
            (e) =>
              e.state === "paused" &&
              e.tenantId === a.tenantId &&
              e.userId === a.userId,
          ).length,
        },
        global: { active: entries.filter(charged).length },
        uncertain: a.admin
          ? entries.filter(
              (e) =>
                e.tenantId === a.tenantId &&
                ["reserved", "unknown"].includes(e.state),
            )
          : undefined,
      };
    });
  }
}
