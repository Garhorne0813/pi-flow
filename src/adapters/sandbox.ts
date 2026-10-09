import {
  Sandbox,
  Volume,
  VolumeMount,
  Config,
  SandboxNotFoundError,
  VolumeNotFoundError,
  ApiError,
} from "@cubesandbox/sdk";
import { createHash } from "node:crypto";
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
} from "./sandbox-policy.js";
import {
  skillMountPath,
  skillScope,
  type SkillVolume,
} from "./skill-mounts.js";
import type { Store } from "../store.js";
import { remoteScript } from "./remote-script.js";
export interface SandboxProvider {
  scope(bundle: string, skills: readonly Skill[]): string;
  createVolume(name: string): Promise<string>;
  create(
    volume: string,
    bundle: string,
    skills: readonly Skill[],
    snapshotId?: string,
  ): Promise<string>;
  connect(sandboxId: string): Promise<void>;
  execute(
    sandboxId: string,
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  kill(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  snapshot(sandboxId: string, name?: string): Promise<string>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  destroyVolume(volumeId: string): Promise<void>;
}
export class CubeProvider implements SandboxProvider {
  private config = new Config();
  constructor(
    private skillVolumes: Record<string, SkillVolume>,
    private user: string,
    private driver: string,
  ) {
    if (/^(root(?::|$)|0(?::|$))/.test(user) || !user)
      throw new Error("Cube execution user must be non-root");
    const volumes = Object.values(skillVolumes).map((s) => s.volume);
    if (new Set(volumes).size !== volumes.length)
      throw new Error("Each skill version requires a separate volume");
  }
  async createVolume(name: string) {
    try {
      return (await Volume.connect(name, { config: this.config })).volumeId;
    } catch (e) {
      if (!(e instanceof VolumeNotFoundError)) throw e;
    }
    try {
      return (
        await Volume.create({ name, driver: this.driver, config: this.config })
      ).volumeId;
    } catch (e) {
      if (e instanceof ApiError && e.statusCode === 409)
        return (await Volume.connect(name, { config: this.config })).volumeId;
      throw e;
    }
  }
  scope(bundle: string, skills: readonly Skill[]) {
    const metadata = skillScope(bundle, skills);
    const volumes = [...skills]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((skill) => {
        const published = Object.hasOwn(this.skillVolumes, skill.id)
          ? this.skillVolumes[skill.id]
          : undefined;
        if (
          !published ||
          published.bundle !== bundle ||
          published.path !== skill.path
        )
          throw new Fault(403, "SKILL_VOLUME_NOT_REGISTERED");
        return { id: skill.id, volume: published.volume };
      });
    return createHash("sha256")
      .update(JSON.stringify({ metadata, volumes }))
      .digest("hex");
  }
  async create(
    volume: string,
    bundle: string,
    skills: readonly Skill[],
    snapshotId?: string,
  ) {
    const scope = this.scope(bundle, skills);
    const selected = skills.map((skill) => ({
      skill,
      published: this.skillVolumes[skill.id]!,
    }));
    const w = await Volume.connect(volume, { config: this.config });
    const volumeMounts: Record<string, Volume | VolumeMount> = {
      "/workspace": w,
    };
    const mounted = new Set([w.volumeId]);
    for (const { skill, published } of selected) {
      const v = await Volume.connect(published.volume, { config: this.config });
      if (mounted.has(v.volumeId))
        throw new Fault(403, "SKILL_VOLUME_CONFLICT");
      mounted.add(v.volumeId);
      volumeMounts[skillMountPath(skill)] = new VolumeMount(v, {
        readOnly: true,
      });
    }
    const sb = await Sandbox.create({
      config: this.config,
      ...(snapshotId ? { templateId: snapshotId } : {}),
      volumeMounts,
      network: { allowPublicTraffic: false },
      metadata: {
        harnessWorkspaceVolume: volume,
        harnessSkillBundle: bundle,
        harnessSkillScope: scope,
      },
    });
    return sb.sandboxId;
  }
  async connect(sid: string) {
    try {
      await Sandbox.connect(sid, { config: this.config });
    } catch (e) {
      if (e instanceof SandboxNotFoundError)
        throw new Fault(410, "SANDBOX_GONE");
      throw e;
    }
  }
  async execute(sid: string, op: string, args: Record<string, unknown>) {
    const sb = await Sandbox.connect(sid, { config: this.config });
    const script = Buffer.from(remoteScript).toString("base64");
    const params = Buffer.from(JSON.stringify({ op, args })).toString("base64");
    const cmd = `python3 -c "import base64;exec(base64.b64decode('${script}'))" '${params}'`;
    const result = await sb.commands.run(cmd, {
      user: this.user,
      cwd: "/workspace",
      timeoutMs: 130000,
    });
    if (result.exitCode !== 0) throw new Fault(502, "REMOTE_TOOL_FAILED");
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Fault(502, "INVALID_SANDBOX_RESULT");
    }
  }
  async kill(sid: string) {
    try {
      // Control-plane deletion must not auto-resume a paused instance.
      const s = new Sandbox({ sandboxID: sid }, this.config);
      await s.kill();
    } catch (e) {
      if (
        !(e instanceof SandboxNotFoundError) &&
        !(e instanceof ApiError && e.statusCode === 404)
      )
        throw e;
    }
  }
  async pause(sid: string) {
    const s = new Sandbox({ sandboxID: sid }, this.config);
    await s.pause({ wait: true });
  }
  async snapshot(sid: string, name?: string) {
    return (
      await new Sandbox({ sandboxID: sid }, this.config).createSnapshot(name)
    ).snapshotId;
  }
  async deleteSnapshot(id: string) {
    try {
      await Sandbox.deleteSnapshot(id, { config: this.config });
    } catch (e) {
      if (!(e instanceof ApiError && e.statusCode === 404)) throw e;
    }
  }
  async destroyVolume(vid: string) {
    await Volume.destroy(vid, { config: this.config });
  }
}
// Test/demo adapter stores files in memory and never executes a local command.
export class DemoSandbox implements SandboxProvider {
  volumes = new Map<string, Map<string, string>>();
  boxes = new Map<string, string>();
  skillSelections = new Map<string, readonly Skill[]>();
  paused = new Set<string>();
  snapshots = new Map<string, { skills: readonly Skill[] }>();
  scope(bundle: string, skills: readonly Skill[]) {
    return skillScope(bundle, skills);
  }
  async createVolume(name: string) {
    if (!this.volumes.has(name)) this.volumes.set(name, new Map());
    return name;
  }
  async create(
    v: string,
    b: string,
    skills: readonly Skill[] = [],
    snapshotId?: string,
  ) {
    if (snapshotId && !this.snapshots.has(snapshotId))
      throw new Fault(404, "SNAPSHOT_NOT_FOUND");
    skillScope(b, skills);
    if (!this.volumes.has(v)) this.volumes.set(v, new Map());
    const sid = crypto.randomUUID();
    this.boxes.set(sid, v);
    this.skillSelections.set(sid, structuredClone(skills));
    return sid;
  }
  async connect(s: string) {
    if (!this.boxes.has(s)) throw new Fault(410, "SANDBOX_GONE");
    this.paused.delete(s);
  }
  async execute(s: string, op: string, a: Record<string, unknown>) {
    await this.connect(s);
    const files = this.volumes.get(this.boxes.get(s)!)!;
    const raw = String(a.path ?? "/workspace");
    const p = raw.startsWith("/") ? raw : "/workspace/" + raw;
    if (!p.startsWith("/workspace/") && p !== "/workspace")
      throw new Fault(403, "PATH_DENIED");
    if (p.split("/").includes("..")) throw new Fault(403, "PATH_DENIED");
    if (op === "write") {
      files.set(p, String(a.content));
      return { written: true };
    }
    if (op === "read") {
      if (!files.has(p)) throw new Fault(404, "FILE_NOT_FOUND");
      return { text: files.get(p) };
    }
    if (op === "ls" || op === "find") return { entries: [...files.keys()] };
    throw new Fault(501, "DEMO_TOOL_UNSUPPORTED");
  }
  async kill(s: string) {
    this.boxes.delete(s);
    this.skillSelections.delete(s);
    this.paused.delete(s);
  }
  async pause(s: string) {
    if (!this.boxes.has(s)) throw new Fault(410, "SANDBOX_GONE");
    this.paused.add(s);
  }
  async snapshot(s: string, _name?: string) {
    await this.connect(s);
    const id = crypto.randomUUID();
    this.snapshots.set(id, {
      skills: structuredClone(this.skillSelections.get(s)!),
    });
    return id;
  }
  async deleteSnapshot(id: string) {
    this.snapshots.delete(id);
  }
  async destroyVolume(v: string) {
    this.volumes.delete(v);
  }
}
export class SandboxManager {
  readonly policy: SandboxPolicy;
  readonly capacity: SandboxCapacity;
  private nextSweepAt = 0;
  constructor(
    private store: Store,
    private provider: SandboxProvider,
    policy: Partial<SandboxPolicy> = {},
    private canUseBundle: (bundle: string, tenant: string) => boolean = () =>
      true,
  ) {
    this.policy = SandboxPolicySchema.parse(policy);
    this.capacity = new SandboxCapacity(store, this.policy);
  }
  async withLease<T>(
    a: Actor,
    wid: string,
    owner: string,
    bundle: string,
    fn: (sid: string) => Promise<T>,
    skillIds: readonly string[] = [],
  ): Promise<T> {
    if (!this.canUseBundle(bundle, a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    const { skills, scope } = await this.store.tx(a.tenantId, (s) => {
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
      w.lock = { owner, expires: Date.now() + 180000 };
      w.bundle = bundle;
      return { skills, scope };
    });
    let failed = false;
    let activeSid: string | undefined;
    let reserved = false;
    let activated = false;
    const timer = setInterval(() => {
      void this.store
        .tx(a.tenantId, (s) => {
          const w = s.workspaces[wid];
          if (w?.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
          w.lock.expires = Date.now() + 180000;
        })
        .catch(() => {
          failed = true;
          if (activeSid) void this.provider.kill(activeSid).catch(() => {});
        });
    }, 10000);
    try {
      const w = await this.store.tx(a.tenantId, (s) => workspace(s, a, wid));
      let vid = w.volumeId;
      if (!vid) {
        vid = await this.provider.createVolume(`ws-${wid}`);
        await this.store.tx(a.tenantId, (s) => {
          const w = workspace(s, a, wid);
          if (w.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
          w.volumeId = vid;
        });
      }
      let sid = w.sandboxId;
      await this.capacity.reserve(a.tenantId, w, owner);
      reserved = true;
      // Legacy boxes mounted entire bundles. Missing scope also forces replacement.
      if (sid && w.sandboxSkillScope !== scope) {
        await this.provider.kill(sid);
        await this.store.tx(a.tenantId, (s) => {
          const w = workspace(s, a, wid);
          if (w.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
          delete w.sandboxId;
          delete w.sandboxSkillScope;
          delete w.sandboxState;
        });
        await this.capacity.pending(a.tenantId, wid, owner);
        sid = undefined;
      }
      if (sid) {
        try {
          await this.provider.connect(sid);
        } catch (e) {
          if (e instanceof Fault && e.code === "SANDBOX_GONE") {
            sid = undefined;
            await this.capacity.pending(a.tenantId, wid, owner);
            await this.store.tx(a.tenantId, (s) => {
              delete s.workspaces[wid]!.sandboxId;
              delete s.workspaces[wid]!.sandboxState;
            });
          } else throw e;
        }
      }
      if (!sid) {
        sid = await this.provider.create(vid, bundle, skills);
        activeSid = sid;
        await this.capacity.pending(a.tenantId, wid, owner, sid);
        const created = sid;
        try {
          await this.store.tx(a.tenantId, (s) => {
            const w = workspace(s, a, wid);
            if (w.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
            w.sandboxId = created;
            w.sandboxSkillScope = scope;
            w.sandboxSkills = [...skillIds];
          });
        } catch (e) {
          await this.provider.kill(created);
          await this.capacity.released(a.tenantId, wid);
          reserved = false;
          throw e;
        }
      }
      activeSid = sid;
      await this.store.tx(a.tenantId, (s) => {
        const w = workspace(s, a, wid);
        if (w.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
        w.sandboxState = "active";
        w.sandboxLastUsedAt = Date.now();
      });
      await this.capacity.active(a.tenantId, wid, owner, sid);
      activated = true;
      if (failed) throw new Fault(409, "LEASE_LOST");
      const result = await fn(sid);
      if (failed) throw new Fault(409, "LEASE_LOST");
      return result;
    } finally {
      clearInterval(timer);
      if (reserved && !activated)
        await this.capacity.unknown(a.tenantId, wid, owner, activeSid);
      await this.store.tx(a.tenantId, (s) => {
        const w = s.workspaces[wid];
        if (w?.lock?.owner === owner) {
          delete w.lock;
          if (activated) w.sandboxLastUsedAt = Date.now();
          else if (reserved) w.sandboxState = "unknown";
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
        let killing: Promise<void> | undefined;
        const stop = () => {
          killing = this.provider.kill(sid);
          void killing.catch(() => {});
        };
        signal?.addEventListener("abort", stop, { once: true });
        try {
          const r = await this.provider.execute(sid, op, args);
          signal?.throwIfAborted();
          return r;
        } finally {
          signal?.removeEventListener("abort", stop);
          if (killing) {
            try {
              await killing;
              await this.capacity.released(a.tenantId, wid);
              await this.store.tx(a.tenantId, (s) => {
                const w = s.workspaces[wid];
                if (w) {
                  delete w.sandboxId;
                  delete w.sandboxState;
                  delete w.sandboxSkillScope;
                }
              });
            } catch {
              await this.capacity.unknown(a.tenantId, wid);
              await this.store.tx(a.tenantId, (s) => {
                if (s.workspaces[wid])
                  s.workspaces[wid]!.sandboxState = "unknown";
              });
              throw new Fault(502, "REMOTE_CANCEL_UNCONFIRMED");
            }
          }
        }
      },
      skillIds,
    );
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
      if (w.lock && w.lock.expires > Date.now())
        throw new Fault(409, "WORKSPACE_BUSY");
      if (
        options.cutoff !== undefined &&
        (w.sandboxLastUsedAt ?? Date.now()) > options.cutoff
      )
        throw new Fault(409, "SANDBOX_NOT_IDLE");
      if (
        Object.values(s.runs).some(
          (r) =>
            s.sessions[r.sessionId]?.workspaceId === wid &&
            (options.allRuns
              ? !terminal(r.state)
              : ["QUEUED", "RUNNING"].includes(r.state)),
        )
      )
        throw new Fault(409, "ACTIVE_RUNS");
      w.lock = { owner, expires: Date.now() + 180000 };
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
      if (w.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
      fn(w);
    });
  }
  private async pauseInstance(a: Actor, w: Workspace, owner: string) {
    if (!w.sandboxId || w.sandboxState === "paused") return;
    try {
      await this.provider.pause(w.sandboxId);
      await this.record(a, w.id, owner, (w) => {
        w.sandboxState = "paused";
      });
      await this.capacity.paused(a.tenantId, w.id);
    } catch (e) {
      if (e instanceof Fault && e.code === "SANDBOX_GONE") {
        await this.record(a, w.id, owner, (w) => {
          delete w.sandboxId;
          delete w.sandboxState;
          delete w.sandboxSkillScope;
        });
        await this.capacity.released(a.tenantId, w.id);
      } else {
        await this.capacity.unknown(a.tenantId, w.id);
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
    try {
      if (sid) await this.provider.kill(sid);
      await this.record(a, w.id, owner, (w) => {
        delete w.sandboxId;
        delete w.sandboxState;
        delete w.sandboxSkillScope;
      });
      await this.capacity.released(a.tenantId, w.id);
    } catch (e) {
      await this.capacity.unknown(a.tenantId, w.id);
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
    const w = await this.store.tx(a.tenantId, (s) =>
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
    return this.store.tx(a.tenantId, (s) => {
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
      const candidates = await this.store.tx(tenantId, (s) =>
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
          )
            result.failed++;
        }
      }
    }
    return result;
  }
  async listSnapshots(a: Actor, wid: string) {
    return this.store.tx(a.tenantId, (s) => ({
      items: Object.values(workspace(s, a, wid).sandboxSnapshots ?? {}),
    }));
  }
  private async snapshotSelection(a: Actor, snapshot: SandboxSnapshot) {
    if (!this.canUseBundle(snapshot.bundle, a.tenantId))
      throw new Fault(403, "BUNDLE_NOT_GRANTED");
    const skills = await this.store.tx(a.tenantId, (s) =>
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
        await this.capacity.reserve(a.tenantId, w, owner);
        try {
          await this.provider.connect(w.sandboxId);
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
      w.volumeId ?? (await this.provider.createVolume(`ws-${w.id}`));
    await this.record(a, w.id, owner, (w) => {
      w.volumeId = volume;
      w.bundle = snapshot.bundle;
    });
    await this.capacity.reserve(a.tenantId, w, owner);
    let sid: string | undefined;
    try {
      if (w.sandboxId) await this.provider.kill(w.sandboxId);
      await this.capacity.pending(a.tenantId, w.id, owner);
      await this.record(a, w.id, owner, (w) => {
        delete w.sandboxId;
        delete w.sandboxState;
        delete w.sandboxSkillScope;
      });
      sid = await this.provider.create(
        volume,
        snapshot.bundle,
        skills,
        snapshot.id,
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
      if (w.lock && w.lock.expires > Date.now())
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
      w.lock = { owner: crypto.randomUUID(), expires: Date.now() + 180000 };
      return w;
    });
    let killed = false;
    try {
      const entry = await this.capacity.get(a.tenantId, wid);
      const sid = entry?.sandboxId ?? w.sandboxId;
      if (entry && !sid) throw new Fault(409, "SANDBOX_OUTCOME_UNKNOWN");
      if (sid) {
        try {
          await this.provider.kill(sid);
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
      await this.capacity.released(a.tenantId, wid);
      for (const snapshot of Object.values(w.sandboxSnapshots ?? {})) {
        await this.provider.deleteSnapshot(snapshot.id);
        await this.store.tx(a.tenantId, (s) => {
          delete s.workspaces[wid]!.sandboxSnapshots![snapshot.id];
        });
      }
      if (w.volumeId) await this.provider.destroyVolume(w.volumeId);
      await this.store.tx(a.tenantId, (s) => {
        delete s.workspaces[wid];
      });
    } catch (e) {
      if (!killed) await this.capacity.unknown(a.tenantId, wid);
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
