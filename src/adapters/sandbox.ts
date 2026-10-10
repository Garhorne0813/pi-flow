import { posix } from "node:path";
import { telemetry } from "../telemetry.js";
import {
  Fault,
  workspace,
  audit,
  terminal,
  type Actor,
  type Skill,
  type Workspace,
  type SandboxSnapshot,
} from "../domain.js";
import {
  SandboxCapacity,
  SandboxPolicySchema,
  type SandboxPolicy,
  type CapacityEntry,
} from "./sandbox-policy.js";
import type { Store } from "../store.js";
import type { SandboxProvider, SandboxAsset } from "../sandbox/provider.js";
import { remote } from "../sandbox/remote.js";
import {
  assertLifecycleAvailable,
  assertLease,
} from "../sandbox/lease-manager.js";
export type { SandboxProvider, SandboxAsset } from "../sandbox/provider.js";
export { CubeProvider } from "../sandbox/cube-provider.js";
export { DemoSandbox } from "../sandbox/demo-provider.js";
export class SandboxManager {
  readonly policy: SandboxPolicy;
  readonly capacity: SandboxCapacity;
  private nextSweepAt = 0;
  async inventory() {
    if (!this.provider.inventory)
      throw new Fault(503, "SANDBOX_INVENTORY_UNSUPPORTED");
    return this.provider.inventory();
  }
  async reconcileOrphan(expected: CapacityEntry, asset: SandboxAsset) {
    const wid = expected.workspaceId.replace(/:files$/, "");
    const actor = {
      tenantId: expected.tenantId,
      userId: expected.userId,
      admin: false,
    };
    return this.managed(
      actor,
      wid,
      "sandbox.reconcile",
      async (w, owner) => {
        if (
          w.volumeId !== asset.volumeId ||
          !expected.operation ||
          (!expected.sandboxId && expected.operation !== asset.operation) ||
          (expected.sandboxId && expected.sandboxId !== asset.sandboxId)
        )
          throw new Fault(409, "RECONCILE_IDENTITY_UNCONFIRMED");
        if (w.sandboxId === asset.sandboxId && w.sandboxState !== "unknown")
          throw new Fault(409, "RECONCILE_ACTIVE_INSTANCE");
        const references = await this.store.capacityRead((s) =>
          Object.values(s.entries).some(
            (e) =>
              e.sandboxId === asset.sandboxId &&
              (e.tenantId !== expected.tenantId ||
                e.workspaceId !== expected.workspaceId) &&
              e.state !== "released",
          ),
        );
        if (references) throw new Fault(409, "RECONCILE_IDENTITY_UNCONFIRMED");
        await this.record(actor, wid, owner, () => {});
        // CAS is the final fence. Another reconciler or newer operation wins
        // before any remote deletion; the loser never calls kill.
        await this.capacity.claim(
          actor.tenantId,
          expected.workspaceId,
          expected,
          owner,
        );
        await this.capacity.pending(
          actor.tenantId,
          expected.workspaceId,
          owner,
          asset.sandboxId,
        );
        try {
          await this.kill(actor, expected.workspaceId, owner, asset.sandboxId);
          await this.record(actor, wid, owner, (current) => {
            if (current.sandboxId === asset.sandboxId) {
              delete current.sandboxId;
              delete current.sandboxState;
              delete current.sandboxSkillScope;
            }
          });
          await this.capacity.released(
            actor.tenantId,
            expected.workspaceId,
            owner,
          );
        } catch (e) {
          await this.capacity.unknown(
            actor.tenantId,
            expected.workspaceId,
            owner,
            asset.sandboxId,
          );
          throw e;
        }
      },
      { allRuns: true },
    );
  }
  constructor(
    private store: Store,
    private provider: SandboxProvider,
    policy: Partial<SandboxPolicy> = {},
    private canUseBundle: (bundle: string, tenant: string) => boolean = () =>
      true,
    private limits = { remoteTimeoutMs: 30000, cleanupTimeoutMs: 1000 },
  ) {
    if (Object.values(limits).some((v) => !Number.isFinite(v) || v <= 0))
      throw new Error("Invalid Sandbox time limits");
    // Every control-plane operation has a local bound, even for SDKs that
    // ignore cancellation. Creation uses explicit late-result reconciliation.
    const raw = provider;
    this.provider = new Proxy(raw, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (
          [
            "scope",
            "create",
            "createVolume",
            "connect",
            "kill",
            "execute",
          ].includes(String(key))
        )
          return value.bind(target);
        return (...args: unknown[]) =>
          this.remote(
            () => value.apply(target, args),
            undefined,
            undefined,
            this.limits.remoteTimeoutMs,
          );
      },
    });
    this.policy = SandboxPolicySchema.parse(policy);
    this.capacity = new SandboxCapacity(store, this.policy);
  }
  private remote<T>(
    start: () => Promise<T>,
    signal?: AbortSignal,
    late?: (value: T) => Promise<void>,
    timeout = this.limits.remoteTimeoutMs,
  ) {
    return remote(start, signal, late, timeout);
  }
  private kill(a: Actor, wid: string, owner: string, sid: string) {
    return this.remote(
      () => this.provider.kill(sid),
      undefined,
      async () => {
        const current = await this.capacity.inspect(a.tenantId, wid);
        if (current?.operation === owner && current.sandboxId === sid) {
          await this.capacity.released(a.tenantId, wid, owner);
          await this.store.tx(a.tenantId, (s) =>
            audit(
              s,
              a,
              "sandbox.kill.reconciled",
              wid,
              JSON.stringify({ owner, sandboxId: sid }),
            ),
          );
        }
      },
      this.limits.cleanupTimeoutMs,
    );
  }
  private async lateVolume(
    a: Actor,
    wid: string,
    owner: string,
    volumeId: string,
  ) {
    await this.store.tx(a.tenantId, (s) => {
      // Workspace volumes have a deterministic name; never destroy a shared
      // volume merely because its response arrived after the Run finished.
      audit(
        s,
        a,
        "sandbox.volume.late",
        wid,
        JSON.stringify({ owner, volumeId }),
      );
    });
    const current = await this.capacity.inspect(a.tenantId, wid);
    if (
      current?.operation === owner &&
      !current.sandboxId &&
      (await this.capacity.released(a.tenantId, wid, owner))
    )
      await this.store.tx(a.tenantId, (s) => {
        const w = s.workspaces[wid];
        if (w && !w.lock && !w.sandboxId) delete w.sandboxState;
      });
  }
  private async lateSandbox(a: Actor, wid: string, owner: string, sid: string) {
    await this.store.tx(a.tenantId, (s) => {
      audit(
        s,
        a,
        "sandbox.creation.late",
        wid,
        JSON.stringify({ owner, sandboxId: sid }),
      );
    });
    const current = await this.capacity.inspect(a.tenantId, wid);
    // Never kill a successor's instance, including a reused provider ID.
    if (current?.operation !== owner) {
      if (current?.sandboxId !== sid)
        await this.capacity.orphan(
          a,
          wid,
          owner,
          sid,
          current?.userId ??
            (await this.store.read(
              a.tenantId,
              (s) =>
                s.workspaces[wid.replace(/:files$/, "")]?.ownerId ?? a.userId,
            )),
        );
      return;
    }
    try {
      await this.capacity.pending(a.tenantId, wid, owner, sid);
      await this.kill(a, wid, owner, sid);
      if (await this.capacity.released(a.tenantId, wid, owner))
        await this.store.tx(a.tenantId, (s) => {
          const w = s.workspaces[wid];
          if (w && !w.lock && (!w.sandboxId || w.sandboxId === sid)) {
            delete w.sandboxId;
            delete w.sandboxState;
            delete w.sandboxSkillScope;
          }
          audit(
            s,
            a,
            "sandbox.creation.reconciled",
            wid,
            JSON.stringify({ owner, sandboxId: sid }),
          );
        });
    } catch {
      await this.capacity.unknown(a.tenantId, wid, owner, sid);
    }
  }
  private async cancellationCleanup(
    a: Actor,
    wid: string,
    owner: string,
    sid: string | undefined,
    killing?: Promise<void>,
    creationStarted = false,
  ) {
    const current = await this.capacity.inspect(a.tenantId, wid);
    if (current?.operation !== owner)
      throw new Fault(409, "CAPACITY_LEASE_LOST");
    if (!sid && creationStarted) {
      await this.capacity.unknown(a.tenantId, wid, owner);
      throw new Fault(502, "REMOTE_CANCEL_UNCONFIRMED");
    }
    try {
      if (sid) {
        await this.capacity.pending(a.tenantId, wid, owner, sid);
        await this.remote(
          () => killing ?? this.kill(a, wid, owner, sid),
          undefined,
          undefined,
          this.limits.cleanupTimeoutMs,
        );
      }
      const released = await this.capacity.released(a.tenantId, wid, owner);
      if (released)
        await this.store.tx(a.tenantId, (s) => {
          const w = s.workspaces[wid];
          if (w?.lock?.owner === owner) {
            delete w.sandboxId;
            delete w.sandboxState;
            delete w.sandboxSkillScope;
          }
        });
    } catch (e) {
      if (e instanceof Fault && e.code === "CAPACITY_LEASE_LOST") throw e;
      const marked = await this.capacity.unknown(a.tenantId, wid, owner, sid);
      if (marked)
        await this.store.tx(a.tenantId, (s) => {
          const w = s.workspaces[wid];
          if (w?.lock?.owner === owner) w.sandboxState = "unknown";
        });
      throw new Fault(502, "REMOTE_CANCEL_UNCONFIRMED");
    }
  }
  async withLease<T>(
    a: Actor,
    wid: string,
    owner: string,
    bundle: string,
    fn: (sid: string) => Promise<T>,
    skillIds: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    owner = `${owner}:${crypto.randomUUID()}`;
    if (!this.canUseBundle(bundle, a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    const { skills, scope } = await this.store.tx(a.tenantId, (s) => {
      signal?.throwIfAborted();
      const w = workspace(s, a, wid);
      if (w.lock && w.lock.expires > Date.now())
        throw new Fault(409, "WORKSPACE_BUSY");
      if (w.bundle && w.bundle !== bundle)
        throw new Fault(403, "SKILL_BUNDLE_MISMATCH");
      const skills = skillIds.map((id) => {
        const sk = s.skills[id];
        if (!sk?.enabled || sk.bundle !== bundle)
          throw new Fault(403, "SKILL_DENIED");
        return sk;
      });
      const scope = this.provider.scope(bundle, skills);
      w.lock = { owner, expires: Date.now() + 180000, kind: "agent" };
      w.bundle = bundle;
      return { skills, scope };
    });
    let failed = false,
      reserved = false,
      activated = false,
      creationStarted = false,
      connecting = false;
    let activeSid: string | undefined, killing: Promise<void> | undefined;
    const assertOwned = async () => {
      signal?.throwIfAborted();
      if (failed) throw new Fault(409, "LEASE_LOST");
      await this.store.read(a.tenantId, (s) => {
        const w = workspace(s, a, wid);
        assertLease(w, owner);
      });
      signal?.throwIfAborted();
    };
    const stop = () => {
      if (activeSid && !killing) {
        const sid = activeSid;
        killing = (async () => {
          // Keep ownership while deletion is in flight; a late callback cannot
          // kill a reused instance or overwrite a successor's capacity record.
          await this.capacity.pending(a.tenantId, wid, owner, sid);
          await this.kill(a, wid, owner, sid);
        })();
        void killing.catch(() => {});
      }
    };
    const timer = setInterval(() => {
      void this.store
        .tx(a.tenantId, (s) => {
          const w = s.workspaces[wid];
          if (w?.lock?.owner !== owner || w.lock.expires < Date.now())
            throw new Fault(409, "LEASE_LOST");
          w.lock.expires = Date.now() + 180000;
        })
        .catch(() => {
          failed = true;
          stop();
        });
    }, 10000);
    try {
      await assertOwned();
      const w = await this.store.read(a.tenantId, (s) => workspace(s, a, wid));
      await this.capacity.adoptLegacy();
      const expected = await this.capacity.inspect(a.tenantId, wid);
      await this.capacity.reserve(a.tenantId, w, owner, expected);
      reserved = true;
      let vid = w.volumeId;
      if (!vid) {
        await assertOwned();
        vid = await this.remote(
          () => {
            creationStarted = true;
            return this.provider.createVolume(`ws-${wid}`);
          },
          signal,
          (id) => this.lateVolume(a, wid, owner, id),
        );
        creationStarted = false;
        await this.record(a, wid, owner, (w) => {
          w.volumeId = vid;
        });
      }
      await assertOwned();
      let sid = w.sandboxId;
      activeSid = sid;
      await assertOwned();
      if (sid && w.sandboxSkillScope !== scope) {
        await this.remote(() => this.kill(a, wid, owner, sid!), signal);
        activeSid = sid = undefined;
        await this.record(a, wid, owner, (w) => {
          delete w.sandboxId;
          delete w.sandboxSkillScope;
          delete w.sandboxState;
        });
        await this.capacity.pending(a.tenantId, wid, owner);
      }
      if (sid) {
        await assertOwned();
        try {
          connecting = true;
          const connectingSid = sid;
          await this.remote(
            () => this.provider.connect(connectingSid),
            signal,
            () => this.lateSandbox(a, wid, owner, connectingSid),
          );
          connecting = false;
        } catch (e) {
          if (!(e instanceof Fault && e.code === "SANDBOX_GONE")) throw e;
          connecting = false;
          activeSid = sid = undefined;
          await this.capacity.pending(a.tenantId, wid, owner);
          await this.record(a, wid, owner, (w) => {
            delete w.sandboxId;
            delete w.sandboxState;
          });
        }
        await assertOwned();
      }
      if (!sid) {
        await assertOwned();
        await this.store.tx(a.tenantId, (s) =>
          audit(
            s,
            a,
            "sandbox.creation.dispatched",
            wid,
            JSON.stringify({ owner, volumeId: vid }),
          ),
        );
        sid = await this.remote(
          () => {
            creationStarted = true;
            return this.provider.create(vid!, bundle, skills, undefined, owner);
          },
          signal,
          (id) => this.lateSandbox(a, wid, owner, id),
        );
        activeSid = sid;
        await this.capacity.pending(a.tenantId, wid, owner, sid);
        await assertOwned();
        await this.record(a, wid, owner, (w) => {
          w.sandboxId = sid;
          w.sandboxSkillScope = scope;
          w.sandboxSkills = [...skillIds];
        });
      }
      activeSid = sid;
      await assertOwned();
      await this.record(a, wid, owner, (w) => {
        w.sandboxState = "active";
        w.sandboxLastUsedAt = Date.now();
      });
      await this.capacity.active(a.tenantId, wid, owner, sid);
      activated = true;
      signal?.addEventListener("abort", stop, { once: true });
      // An already aborted signal does not dispatch a newly added listener.
      if (signal?.aborted) stop();
      await assertOwned();
      const result = await this.remote(
        () => fn(sid),
        signal,
        undefined,
        130000,
      );
      await assertOwned();
      return result;
    } catch (e) {
      if (
        reserved &&
        (signal?.aborted ||
          failed ||
          (e instanceof Fault &&
            [
              "LEASE_LOST",
              "CAPACITY_LEASE_LOST",
              "SANDBOX_REMOTE_TIMEOUT",
            ].includes(e.code)))
      ) {
        if (connecting) {
          await this.capacity.unknown(a.tenantId, wid, owner, activeSid);
          throw new Fault(502, "REMOTE_CANCEL_UNCONFIRMED");
        }
        await this.cancellationCleanup(
          a,
          wid,
          owner,
          activeSid,
          killing,
          creationStarted,
        );
        reserved = false;
      }
      throw e;
    } finally {
      signal?.removeEventListener("abort", stop);
      clearInterval(timer);
      if (reserved && !activated)
        await this.capacity.unknown(a.tenantId, wid, owner, activeSid);
      const remaining =
        reserved && !activated
          ? await this.capacity.inspect(a.tenantId, wid)
          : undefined;
      await this.store.tx(a.tenantId, (s) => {
        const w = s.workspaces[wid];
        if (w?.lock?.owner === owner) {
          delete w.lock;
          if (activated && w.sandboxId) w.sandboxLastUsedAt = Date.now();
          else if (
            remaining?.operation === owner &&
            remaining.state === "unknown"
          )
            w.sandboxState = "unknown";
          else if (
            remaining?.operation === owner &&
            remaining.state === "released" &&
            !w.sandboxId
          )
            delete w.sandboxState;
        }
      });
    }
  }
  async execute(
    a: Actor,
    wid: string,
    owner: string,
    bundle: string,
    op: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    skillIds: readonly string[] = [],
  ) {
    return this.withLease(
      a,
      wid,
      owner,
      bundle,
      async (sid) => {
        signal?.throwIfAborted();
        const skills = await this.store.read(a.tenantId, (s) =>
          skillIds.map((id) => {
            const skill = s.skills[id];
            if (!skill?.enabled || skill.bundle !== bundle)
              throw new Fault(403, "SKILL_DENIED");
            return { path: skill.path, digest: skill.digest };
          }),
        );
        signal?.throwIfAborted();
        return this.provider.execute(sid, op, {
          ...args,
          _skillManifests: skills,
        });
      },
      skillIds,
      signal,
    );
  }
  // File APIs use a temporary instance with only the workspace volume. Its
  // capacity entry survives failed cleanup, while the Agent instance is untouched.
  async executeFile(
    a: Actor,
    wid: string,
    owner: string,
    op: "read" | "ls" | "write",
    args: Record<string, unknown>,
  ) {
    owner = `${owner}:${crypto.randomUUID()}`;
    if (!["read", "ls", "write"].includes(op))
      throw new Fault(403, "TOOL_DENIED");
    const raw = args.path ?? "/workspace";
    if (typeof raw !== "string" || raw.includes("\0"))
      throw new Fault(403, "PATH_DENIED");
    const path = posix.resolve("/workspace", raw);
    if (path !== "/workspace" && !path.startsWith("/workspace/"))
      throw new Fault(403, "PATH_DENIED");
    const writing = op === "write";
    const w = await this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid, writing);
      if (!w.bundle) throw new Fault(409, "CREATE_SESSION_FIRST");
      if (!this.canUseBundle(w.bundle, a.tenantId))
        throw new Fault(403, "BUNDLE_NOT_GRANTED");
      if (w.fileLock && w.fileLock.expires > Date.now())
        throw new Fault(409, "WORKSPACE_BUSY");
      // Readers can run beside Agent tools; volume creation and writes serialize.
      if (
        w.lock &&
        w.lock.expires > Date.now() &&
        (writing || !w.volumeId || w.lock.kind !== "agent")
      )
        throw new Fault(409, "WORKSPACE_BUSY");
      w.fileLock = { owner, expires: Date.now() + 180000 };
      if (writing || !w.volumeId)
        w.lock = { owner, expires: Date.now() + 180000, kind: "files" };
      return w;
    });
    const capacityId = wid + ":files";
    let sid: string | undefined,
      reserved = false,
      creationStarted = false,
      lost = false;
    const heartbeat = setInterval(() => {
      void this.store
        .tx(a.tenantId, (s) => {
          const current = workspace(s, a, wid, writing);
          if (
            current.fileLock?.owner !== owner ||
            current.fileLock.expires < Date.now()
          )
            throw new Fault(409, "LEASE_LOST");
          current.fileLock.expires = Date.now() + 180000;
          if (current.lock?.owner === owner)
            current.lock.expires = Date.now() + 180000;
        })
        .catch(() => {
          lost = true;
        });
    }, 10000);
    const assertFileOwned = () =>
      this.store.read(a.tenantId, (s) => {
        const current = workspace(s, a, wid, writing);
        if (
          lost ||
          current.fileLock?.owner !== owner ||
          current.fileLock.expires < Date.now()
        )
          throw new Fault(409, "LEASE_LOST");
      });
    try {
      await assertFileOwned();
      const old = await this.capacity.get(a.tenantId, capacityId);
      if (old) {
        await assertFileOwned();
        if (!old.sandboxId) throw new Fault(409, "SANDBOX_OUTCOME_UNKNOWN");
        await this.capacity.claim(a.tenantId, capacityId, old, owner);
        try {
          await this.kill(a, capacityId, owner, old.sandboxId);
          await this.capacity.released(a.tenantId, capacityId, owner);
        } catch (e) {
          await this.capacity.unknown(
            a.tenantId,
            capacityId,
            owner,
            old.sandboxId,
          );
          throw e;
        }
      }
      await assertFileOwned();
      let volume = w.volumeId;
      if (!volume) {
        volume = await this.remote(
          () => this.provider.createVolume(`ws-${wid}`),
          undefined,
          (id) => this.lateVolume(a, wid, owner, id),
        );
        await this.store.tx(a.tenantId, (s) => {
          const current = workspace(s, a, wid, writing);
          if (
            current.fileLock?.owner !== owner ||
            current.lock?.owner !== owner
          )
            throw new Fault(409, "LEASE_LOST");
          current.volumeId = volume;
          if (!writing) delete current.lock;
        });
      }
      const expected = await this.capacity.inspect(a.tenantId, capacityId);
      await assertFileOwned();
      await this.capacity.reserve(
        a.tenantId,
        {
          id: capacityId,
          ownerId: w.ownerId,
          name: w.name,
          members: w.members,
        },
        owner,
        expected,
      );
      reserved = true;
      await assertFileOwned();
      creationStarted = true;
      sid = await this.remote(
        () => this.provider.create(volume!, w.bundle!, [], undefined, owner),
        undefined,
        (id) => this.lateSandbox(a, capacityId, owner, id),
      );
      await this.capacity.pending(a.tenantId, capacityId, owner, sid);
      await this.capacity.active(a.tenantId, capacityId, owner, sid);
      if (lost) throw new Fault(409, "LEASE_LOST");
      await this.store.read(a.tenantId, (s) => {
        const current = workspace(s, a, wid, writing);
        if (
          current.fileLock?.owner !== owner ||
          current.fileLock.expires < Date.now()
        )
          throw new Fault(409, "LEASE_LOST");
      });
      const result = await this.remote(
        () =>
          this.provider.execute(sid!, op, {
            ...args,
            path,
            _workspaceOnly: true,
            _skillManifests: [],
          }),
        undefined,
        undefined,
        130000,
      );
      await assertFileOwned();
      return result;
    } finally {
      clearInterval(heartbeat);
      try {
        if (reserved) {
          if (sid) {
            try {
              await this.kill(a, capacityId, owner, sid);
              await this.capacity.released(a.tenantId, capacityId, owner);
            } catch {
              await this.capacity.unknown(a.tenantId, capacityId, owner, sid);
              throw new Fault(502, "FILE_SANDBOX_CLEANUP_UNCONFIRMED");
            }
          } else if (creationStarted)
            await this.capacity.unknown(a.tenantId, capacityId, owner);
          else await this.capacity.released(a.tenantId, capacityId, owner);
        }
      } finally {
        await this.store.tx(a.tenantId, (s) => {
          const current = s.workspaces[wid];
          if (current?.fileLock?.owner === owner) delete current.fileLock;
          if (current?.lock?.owner === owner) delete current.lock;
        });
      }
    }
  }
  private async managed<T>(
    a: Actor,
    wid: string,
    action: string,
    fn: (w: Workspace, owner: string) => Promise<T>,
    options: { cutoff?: number; allRuns?: boolean } = {},
  ) {
    await this.capacity.adoptLegacy();
    const owner = crypto.randomUUID();
    const w = await this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid, true);
      assertLifecycleAvailable(s, w, options);
      w.lock = { owner, expires: Date.now() + 180000, kind: "lifecycle" };
      return w;
    });
    let lost = false;
    const heartbeat = setInterval(() => {
      void this.store
        .tx(a.tenantId, (s) => {
          const w = s.workspaces[wid];
          if (w?.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
          w.lock.expires = Date.now() + 180000;
        })
        .catch(() => {
          lost = true;
        });
    }, 10000);
    try {
      const result = await fn(w, owner);
      await this.store.tx(a.tenantId, (s) => {
        const w = s.workspaces[wid];
        if (lost || w?.lock?.owner !== owner)
          throw new Fault(409, "LEASE_LOST");
        if (options.cutoff === undefined) w.sandboxLastUsedAt = Date.now();
        audit(s, a, action, wid);
      });
      return result;
    } catch (e) {
      await this.store.tx(a.tenantId, (s) =>
        audit(
          s,
          a,
          action,
          wid,
          e instanceof Fault ? e.code : "LIFECYCLE_FAILED",
        ),
      );
      throw e;
    } finally {
      clearInterval(heartbeat);
      await this.store.tx(a.tenantId, (s) => {
        const w = s.workspaces[wid];
        if (w?.lock?.owner === owner) delete w.lock;
      });
    }
  }
  private async record(
    a: Actor,
    wid: string,
    owner: string,
    fn: (w: Workspace) => void,
  ) {
    await this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid);
      assertLease(w, owner);
      fn(w);
    });
  }
  private async reserveManaged(a: Actor, w: Workspace, owner: string) {
    const expected = await this.capacity.inspect(a.tenantId, w.id);
    await this.record(a, w.id, owner, () => {});
    await this.capacity.reserve(a.tenantId, w, owner, expected);
  }
  private async pauseInstance(a: Actor, w: Workspace, owner: string) {
    if (!w.sandboxId || w.sandboxState === "paused") return;
    const entry = await this.capacity.get(a.tenantId, w.id);
    await this.record(a, w.id, owner, () => {});
    if (entry) await this.capacity.claim(a.tenantId, w.id, entry, owner);
    try {
      await this.provider.pause(w.sandboxId);
      await this.record(a, w.id, owner, (w) => {
        w.sandboxState = "paused";
      });
      await this.capacity.paused(a.tenantId, w.id, owner);
    } catch (e) {
      if (e instanceof Fault && e.code === "SANDBOX_GONE") {
        await this.record(a, w.id, owner, (w) => {
          delete w.sandboxId;
          delete w.sandboxState;
          delete w.sandboxSkillScope;
        });
        await this.capacity.released(a.tenantId, w.id, owner);
      } else {
        await this.capacity.unknown(a.tenantId, w.id, owner);
        await this.record(a, w.id, owner, (w) => {
          w.sandboxState = "unknown";
        });
        throw e;
      }
    }
  }
  private async releaseInstance(a: Actor, w: Workspace, owner: string) {
    const entry = await this.capacity.get(a.tenantId, w.id);
    const sid = entry?.sandboxId ?? w.sandboxId;
    if (!sid && entry) throw new Fault(409, "SANDBOX_OUTCOME_UNKNOWN");
    await this.record(a, w.id, owner, () => {});
    if (entry) await this.capacity.claim(a.tenantId, w.id, entry, owner);
    try {
      if (sid) await this.kill(a, w.id, owner, sid);
      await this.record(a, w.id, owner, (w) => {
        delete w.sandboxId;
        delete w.sandboxState;
        delete w.sandboxSkillScope;
      });
      await this.capacity.released(a.tenantId, w.id, owner);
    } catch (e) {
      await this.capacity.unknown(a.tenantId, w.id, owner);
      await this.record(a, w.id, owner, (w) => {
        w.sandboxState = "unknown";
      });
      throw e;
    }
  }
  async pause(a: Actor, wid: string) {
    return this.managed(a, wid, "sandbox.pause", (w, owner) =>
      this.pauseInstance(a, w, owner),
    );
  }
  async release(a: Actor, wid: string) {
    return this.managed(a, wid, "sandbox.release", (w, owner) =>
      this.releaseInstance(a, w, owner),
    );
  }
  async resume(a: Actor, wid: string) {
    const w = await this.store.read(a.tenantId, (s) =>
      workspace(s, a, wid, true),
    );
    if (!w.bundle) throw new Fault(409, "CREATE_SESSION_FIRST");
    await this.withLease(
      a,
      wid,
      crypto.randomUUID(),
      w.bundle,
      async () => {},
      w.sandboxSkills ?? [],
    );
    await this.store.tx(a.tenantId, (s) => audit(s, a, "sandbox.resume", wid));
    return this.status(a, wid);
  }
  async status(a: Actor, wid: string) {
    return this.store.read(a.tenantId, (s) => {
      const w = workspace(s, a, wid);
      return {
        state: w.sandboxId
          ? (w.sandboxState ?? "active")
          : (w.sandboxState ?? "released"),
        sandboxId: w.sandboxId,
        lastUsedAt: w.sandboxLastUsedAt,
        snapshotCount: Object.keys(w.sandboxSnapshots ?? {}).length,
      };
    });
  }
  async sweepIfDue(now = Date.now()) {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + this.policy.sweepIntervalSeconds * 1000;
    return this.reapIdle(now);
  }
  async reapIdle(now = Date.now()) {
    const result = { paused: 0, released: 0, failed: 0 };
    await this.capacity.adoptLegacy();
    for (const tenantId of await this.store.tenants()) {
      const candidates = await this.store.read(tenantId, (s) =>
        Object.values(s.workspaces).filter((w) => w.sandboxId && !w.deleting),
      );
      for (const w of candidates) {
        if (w.sandboxLastUsedAt === undefined) {
          await this.store.tx(tenantId, (s) => {
            s.workspaces[w.id]!.sandboxLastUsedAt ??= now;
          });
          continue;
        }
        const idle = now - w.sandboxLastUsedAt;
        const release = idle >= this.policy.idleReleaseSeconds * 1000;
        if (
          !release &&
          (idle < this.policy.idlePauseSeconds * 1000 ||
            w.sandboxState === "paused" ||
            w.sandboxState === "unknown")
        )
          continue;
        const a = { tenantId, userId: w.ownerId, admin: false };
        try {
          const cutoff =
            now -
            (release
              ? this.policy.idleReleaseSeconds
              : this.policy.idlePauseSeconds) *
              1000;
          await this.managed(
            a,
            w.id,
            release ? "sandbox.idle_release" : "sandbox.idle_pause",
            (fresh, owner) =>
              release
                ? this.releaseInstance(a, fresh, owner)
                : this.pauseInstance(a, fresh, owner),
            { cutoff },
          );
          if (release) result.released++;
          else result.paused++;
        } catch (e) {
          if (
            !(
              e instanceof Fault &&
              [
                "WORKSPACE_BUSY",
                "ACTIVE_RUNS",
                "SANDBOX_NOT_IDLE",
                "WORKSPACE_NOT_FOUND",
              ].includes(e.code)
            )
          ) {
            result.failed++;
            telemetry.error("sandbox_reclaim", e, { tenantId });
          }
        }
      }
    }
    return result;
  }
  async listSnapshots(a: Actor, wid: string) {
    return this.store.read(a.tenantId, (s) => ({
      items: Object.values(workspace(s, a, wid).sandboxSnapshots ?? {}),
    }));
  }
  private async snapshotSelection(a: Actor, snapshot: SandboxSnapshot) {
    if (!this.canUseBundle(snapshot.bundle, a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    const skills = await this.store.read(a.tenantId, (s) =>
      snapshot.skills.map((id) => {
        const skill = s.skills[id];
        if (!skill?.enabled || skill.bundle !== snapshot.bundle)
          throw new Fault(403, "SKILL_DENIED");
        return skill;
      }),
    );
    if (this.provider.scope(snapshot.bundle, skills) !== snapshot.skillScope)
      throw new Fault(409, "SNAPSHOT_SKILL_SCOPE_MISMATCH");
    return skills;
  }
  private snapshotRecord(w: Workspace, snapshotId: string) {
    const r =
      w.sandboxSnapshots && Object.hasOwn(w.sandboxSnapshots, snapshotId)
        ? w.sandboxSnapshots[snapshotId]
        : undefined;
    if (!r) throw new Fault(404, "SNAPSHOT_NOT_FOUND");
    return r;
  }
  async createSnapshot(a: Actor, wid: string, name?: string) {
    return this.managed(
      a,
      wid,
      "sandbox.snapshot_create",
      async (w, owner) => {
        if (!w.sandboxId || !w.bundle || !w.sandboxSkillScope)
          throw new Fault(409, "SANDBOX_NOT_CREATED");
        if (
          Object.keys(w.sandboxSnapshots ?? {}).length >=
          this.policy.maxSnapshotsPerWorkspace
        )
          throw new Fault(429, "SNAPSHOT_LIMIT");
        const snapshot: SandboxSnapshot = {
          id: "",
          name,
          createdAt: new Date().toISOString(),
          sandboxId: w.sandboxId,
          bundle: w.bundle,
          skills: w.sandboxSkills ?? [],
          skillScope: w.sandboxSkillScope,
        };
        await this.snapshotSelection(a, snapshot);
        await this.reserveManaged(a, w, owner);
        try {
          await this.remote(() => this.provider.connect(w.sandboxId!));
          await this.record(a, wid, owner, (w) => {
            w.sandboxState = "active";
          });
          await this.capacity.active(a.tenantId, wid, owner, w.sandboxId);
        } catch (e) {
          await this.capacity.unknown(a.tenantId, wid, owner, w.sandboxId);
          throw e;
        }
        snapshot.id = await this.provider.snapshot(w.sandboxId, name);
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(snapshot.id))
          throw new Fault(502, "INVALID_SNAPSHOT_ID");
        try {
          await this.record(a, wid, owner, (w) => {
            (w.sandboxSnapshots ??= {})[snapshot.id] = snapshot;
          });
        } catch (e) {
          await this.provider.deleteSnapshot(snapshot.id);
          throw e;
        }
        return snapshot;
      },
      { allRuns: true },
    );
  }
  async deleteSnapshot(a: Actor, wid: string, snapshotId: string) {
    return this.managed(
      a,
      wid,
      "sandbox.snapshot_delete",
      async (w, owner) => {
        this.snapshotRecord(w, snapshotId);
        await this.provider.deleteSnapshot(snapshotId);
        await this.record(a, wid, owner, (w) => {
          delete w.sandboxSnapshots![snapshotId];
        });
      },
      { allRuns: true },
    );
  }
  private async restoreInto(
    a: Actor,
    w: Workspace,
    owner: string,
    snapshot: SandboxSnapshot,
  ) {
    const skills = await this.snapshotSelection(a, snapshot);
    const volume =
      w.volumeId ??
      (await this.remote(
        () => this.provider.createVolume(`ws-${w.id}`),
        undefined,
        (id) => this.lateVolume(a, w.id, owner, id),
      ));
    await this.record(a, w.id, owner, (w) => {
      w.volumeId = volume;
      w.bundle = snapshot.bundle;
    });
    await this.reserveManaged(a, w, owner);
    let sid: string | undefined;
    try {
      if (w.sandboxId) await this.kill(a, w.id, owner, w.sandboxId);
      await this.capacity.pending(a.tenantId, w.id, owner);
      await this.record(a, w.id, owner, (w) => {
        delete w.sandboxId;
        delete w.sandboxState;
        delete w.sandboxSkillScope;
      });
      sid = await this.remote(
        () =>
          this.provider.create(
            volume,
            snapshot.bundle,
            skills,
            snapshot.id,
            owner,
          ),
        undefined,
        (id) => this.lateSandbox(a, w.id, owner, id),
      );
      await this.capacity.pending(a.tenantId, w.id, owner, sid);
      await this.record(a, w.id, owner, (w) => {
        w.sandboxId = sid;
        w.sandboxState = "active";
        w.sandboxSkillScope = snapshot.skillScope;
        w.sandboxSkills = [...snapshot.skills];
      });
      await this.capacity.active(a.tenantId, w.id, owner, sid);
      return { sandboxId: sid, state: "active" };
    } catch (e) {
      await this.capacity.unknown(a.tenantId, w.id, owner, sid);
      await this.record(a, w.id, owner, (w) => {
        w.sandboxState = "unknown";
      });
      throw e;
    }
  }
  async restoreSnapshot(a: Actor, wid: string, snapshotId: string) {
    return this.managed(
      a,
      wid,
      "sandbox.snapshot_restore",
      (w, owner) =>
        this.restoreInto(a, w, owner, this.snapshotRecord(w, snapshotId)),
      { allRuns: true },
    );
  }
  async cloneSnapshot(a: Actor, wid: string, snapshotId: string, name: string) {
    return this.managed(
      a,
      wid,
      "sandbox.snapshot_clone",
      async (source) => {
        const snapshot = this.snapshotRecord(source, snapshotId);
        await this.snapshotSelection(a, snapshot);
        const target: Workspace = {
          id: crypto.randomUUID(),
          name,
          ownerId: a.userId,
          members: { [a.userId]: "owner" },
          bundle: snapshot.bundle,
        };
        await this.store.tx(a.tenantId, (s) => {
          s.workspaces[target.id] = target;
        });
        try {
          await this.managed(
            a,
            target.id,
            "sandbox.clone_create",
            (w, owner) => this.restoreInto(a, w, owner, snapshot),
            { allRuns: true },
          );
          return {
            workspaceId: target.id,
            ...(await this.status(a, target.id)),
          };
        } catch (e) {
          if (!(await this.capacity.get(a.tenantId, target.id))) {
            const w = await this.store.tx(
              a.tenantId,
              (s) => s.workspaces[target.id]!,
            );
            if (w.volumeId) await this.provider.destroyVolume(w.volumeId);
            await this.store.tx(a.tenantId, (s) => {
              delete s.workspaces[target.id];
            });
          }
          throw e;
        }
      },
      { allRuns: true },
    );
  }
  async destroy(a: Actor, wid: string) {
    await this.capacity.adoptLegacy();
    const w = await this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid, true);
      if (
        (w.lock && w.lock.expires > Date.now()) ||
        (w.fileLock && w.fileLock.expires > Date.now())
      )
        throw new Fault(409, "WORKSPACE_BUSY");
      if (
        Object.values(s.runs).some(
          (r) =>
            s.sessions[r.sessionId]?.workspaceId === wid &&
            !["COMPLETED", "FAILED", "CANCELLED"].includes(r.state),
        )
      )
        throw new Fault(409, "ACTIVE_RUNS");
      w.deleting = true;
      w.lock = {
        owner: crypto.randomUUID(),
        expires: Date.now() + 180000,
        kind: "lifecycle",
      };
      return w;
    });
    let killed = false;
    const owner = w.lock!.owner;
    try {
      const entry = await this.capacity.get(a.tenantId, wid);
      const sid = entry?.sandboxId ?? w.sandboxId;
      if (entry && !sid) throw new Fault(409, "SANDBOX_OUTCOME_UNKNOWN");
      if (entry) await this.capacity.claim(a.tenantId, wid, entry, owner);
      if (sid) {
        try {
          await this.kill(a, wid, owner, sid);
        } catch (e) {
          if (!(e instanceof Fault && e.code === "SANDBOX_GONE")) throw e;
        }
      }
      killed = true;
      await this.store.tx(a.tenantId, (s) => {
        const current = s.workspaces[wid]!;
        delete current.sandboxId;
        delete current.sandboxState;
        delete current.sandboxSkillScope;
      });
      await this.capacity.released(a.tenantId, wid, owner);
      for (const snapshot of Object.values(w.sandboxSnapshots ?? {})) {
        await this.provider.deleteSnapshot(snapshot.id);
        await this.store.tx(a.tenantId, (s) => {
          delete s.workspaces[wid]!.sandboxSnapshots![snapshot.id];
        });
      }
      const files = await this.capacity.get(a.tenantId, wid + ":files");
      if (files) {
        if (!files.sandboxId) throw new Fault(409, "SANDBOX_OUTCOME_UNKNOWN");
        await this.capacity.claim(a.tenantId, wid + ":files", files, owner);
        try {
          await this.kill(a, wid + ":files", owner, files.sandboxId);
          await this.capacity.released(a.tenantId, wid + ":files", owner);
        } catch (e) {
          await this.capacity.unknown(
            a.tenantId,
            wid + ":files",
            owner,
            files.sandboxId,
          );
          throw e;
        }
      }
      if (w.volumeId) await this.provider.destroyVolume(w.volumeId);
      await this.store.tx(a.tenantId, (s) => {
        delete s.workspaces[wid];
      });
    } catch (e) {
      if (!killed) await this.capacity.unknown(a.tenantId, wid, owner);
      await this.store.tx(a.tenantId, (s) => {
        if (s.workspaces[wid]) {
          s.workspaces[wid]!.deleting = false;
          delete s.workspaces[wid]!.lock;
          if (!killed) s.workspaces[wid]!.sandboxState = "unknown";
        }
      });
      throw e;
    }
  }
}
