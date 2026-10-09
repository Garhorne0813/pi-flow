import {
  Sandbox,
  Volume,
  VolumeMount,
  Config,
  SandboxNotFoundError,
  VolumeNotFoundError,
  ApiError,
} from "@cubesandbox/sdk";
import { Fault, workspace, type Actor } from "../domain.js";
import type { Store } from "../store.js";
import { remoteScript } from "./remote-script.js";
export interface SandboxProvider {
  createVolume(name: string): Promise<string>;
  create(volume: string, bundle: string): Promise<string>;
  connect(sandboxId: string): Promise<void>;
  execute(
    sandboxId: string,
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  kill(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  destroyVolume(volumeId: string): Promise<void>;
}
export class CubeProvider implements SandboxProvider {
  private config = new Config();
  constructor(
    private bundles: Record<string, string>,
    private user: string,
    private driver: string,
  ) {
    if (/^(root(?::|$)|0(?::|$))/.test(user) || !user)
      throw new Error("Cube execution user must be non-root");
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
  async create(volume: string, bundle: string) {
    const sid = this.bundles[bundle];
    if (!sid) throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
    const [w, s] = await Promise.all([
      Volume.connect(volume, { config: this.config }),
      Volume.connect(sid, { config: this.config }),
    ]);
    const sb = await Sandbox.create({
      config: this.config,
      volumeMounts: {
        "/workspace": w,
        "/skills": new VolumeMount(s, { readOnly: true }),
      },
      network: { allowPublicTraffic: false },
      metadata: { harnessWorkspaceVolume: volume, harnessSkillBundle: bundle },
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
      const s = await Sandbox.connect(sid, { config: this.config });
      await s.kill();
    } catch (e) {
      if (!(e instanceof SandboxNotFoundError)) throw e;
    }
  }
  async pause(sid: string) {
    const s = await Sandbox.connect(sid, { config: this.config });
    await s.pause();
  }
  async destroyVolume(vid: string) {
    await Volume.destroy(vid, { config: this.config });
  }
}
// Test/demo adapter stores files in memory and never executes a local command.
export class DemoSandbox implements SandboxProvider {
  volumes = new Map<string, Map<string, string>>();
  boxes = new Map<string, string>();
  async createVolume(name: string) {
    if (!this.volumes.has(name)) this.volumes.set(name, new Map());
    return name;
  }
  async create(v: string, _b: string) {
    if (!this.volumes.has(v)) this.volumes.set(v, new Map());
    const sid = crypto.randomUUID();
    this.boxes.set(sid, v);
    return sid;
  }
  async connect(s: string) {
    if (!this.boxes.has(s)) throw new Fault(410, "SANDBOX_GONE");
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
  }
  async pause(_s: string) {}
  async destroyVolume(v: string) {
    this.volumes.delete(v);
  }
}
export class SandboxManager {
  constructor(
    private store: Store,
    private provider: SandboxProvider,
  ) {}
  async withLease<T>(
    a: Actor,
    wid: string,
    owner: string,
    bundle: string,
    fn: (sid: string) => Promise<T>,
  ): Promise<T> {
    await this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid);
      if (w.lock && w.lock.expires > Date.now())
        throw new Fault(409, "WORKSPACE_BUSY");
      if (w.bundle && w.bundle !== bundle)
        throw new Fault(403, "SKILL_BUNDLE_MISMATCH");
      w.lock = { owner, expires: Date.now() + 180000 };
      w.bundle = bundle;
    });
    let failed = false;
    let activeSid: string | undefined;
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
      if (sid) {
        try {
          await this.provider.connect(sid);
        } catch (e) {
          if (e instanceof Fault && e.code === "SANDBOX_GONE") sid = undefined;
          else throw e;
        }
      }
      if (!sid) {
        sid = await this.provider.create(vid, bundle);
        const created = sid;
        try {
          await this.store.tx(a.tenantId, (s) => {
            const w = workspace(s, a, wid);
            if (w.lock?.owner !== owner) throw new Fault(409, "LEASE_LOST");
            w.sandboxId = created;
          });
        } catch (e) {
          await this.provider.kill(created);
          throw e;
        }
      }
      activeSid = sid;
      if (failed) throw new Fault(409, "LEASE_LOST");
      const result = await fn(sid);
      if (failed) throw new Fault(409, "LEASE_LOST");
      return result;
    } finally {
      clearInterval(timer);
      await this.store.tx(a.tenantId, (s) => {
        const w = s.workspaces[wid];
        if (w?.lock?.owner === owner) delete w.lock;
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
  ) {
    return this.withLease(a, wid, owner, bundle, async (sid) => {
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
          } catch {
            throw new Fault(502, "REMOTE_CANCEL_UNCONFIRMED");
          }
        }
      }
    });
  }
  async pause(a: Actor, wid: string) {
    const owner = crypto.randomUUID();
    const w = await this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid, true);
      if (w.lock && w.lock.expires > Date.now())
        throw new Fault(409, "WORKSPACE_BUSY");
      w.lock = { owner, expires: Date.now() + 180000 };
      return w;
    });
    try {
      if (w.sandboxId) await this.provider.pause(w.sandboxId);
    } finally {
      await this.store.tx(a.tenantId, (s) => {
        const w = s.workspaces[wid];
        if (w?.lock?.owner === owner) delete w.lock;
      });
    }
  }
  async destroy(a: Actor, wid: string) {
    const w = await this.store.tx(a.tenantId, (s) => {
      const w = workspace(s, a, wid);
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
      return w;
    });
    try {
      if (w.sandboxId) {
        try {
          await this.provider.kill(w.sandboxId);
        } catch (e) {
          if (!(e instanceof Fault && e.code === "SANDBOX_GONE")) throw e;
        }
      }
      if (w.volumeId) await this.provider.destroyVolume(w.volumeId);
      await this.store.tx(a.tenantId, (s) => {
        delete s.workspaces[wid];
      });
    } catch (e) {
      await this.store.tx(a.tenantId, (s) => {
        if (s.workspaces[wid]) s.workspaces[wid]!.deleting = false;
      });
      throw e;
    }
  }
}
