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
import { Fault, type Skill } from "../domain.js";
import {
  skillMountPath,
  skillScope,
  type SkillVolume,
} from "../adapters/skill-mounts.js";
import { remoteScript } from "../adapters/remote-script.js";
import type { SandboxProvider, SandboxAsset } from "./provider.js";
export class CubeProvider implements SandboxProvider {
  readonly requiresTrafficToken = true;
  // Cube snapshot templates inherit their source volume mounts.
  readonly supportsSnapshotClone = false;
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
  async inventory(): Promise<SandboxAsset[]> {
    const rows = await Sandbox.list(this.config);
    if (!Array.isArray(rows))
      throw new Fault(502, "SANDBOX_INVENTORY_UNSUPPORTED");
    return rows.flatMap((row) => {
      const sandboxId = row.sandboxID ?? row.sandboxId;
      const operation = row.metadata?.harnessOperation;
      const volumeId = row.metadata?.harnessWorkspaceVolume;
      if (
        typeof sandboxId !== "string" ||
        typeof operation !== "string" ||
        typeof volumeId !== "string"
      )
        return [];
      return [{ sandboxId, operation, volumeId }];
    });
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
    operation?: string,
  ) {
    const scope = this.scope(bundle, skills);
    const selected = skills.map((skill) => ({
      skill,
      published: this.skillVolumes[skill.id]!,
    }));
    // Snapshot templates already include their recorded workspace and skill
    // mounts. Re-declaring them makes CubeMaster reject the create request.
    const volumeMounts: Record<string, Volume | VolumeMount> = {};
    if (!snapshotId) {
      const w = await Volume.connect(volume, { config: this.config });
      volumeMounts["/workspace"] = w;
      const mounted = new Set([w.volumeId]);
      for (const { skill, published } of selected) {
        const v = await Volume.connect(published.volume, {
          config: this.config,
        });
        if (mounted.has(v.volumeId))
          throw new Fault(403, "SKILL_VOLUME_CONFLICT");
        mounted.add(v.volumeId);
        volumeMounts[skillMountPath(skill)] = new VolumeMount(v, {
          readOnly: true,
        });
      }
    }
    const sb = await Sandbox.create({
      config: this.config,
      ...(snapshotId ? { templateId: snapshotId } : {}),
      ...(Object.keys(volumeMounts).length ? { volumeMounts } : {}),
      network: { allowPublicTraffic: false },
      metadata: {
        harnessWorkspaceVolume: volume,
        harnessSkillBundle: bundle,
        harnessSkillScope: scope,
        ...(operation ? { harnessOperation: operation } : {}),
      },
    });
    return {
      sandboxId: sb.sandboxId,
      trafficToken: sb.trafficAccessToken ?? undefined,
    };
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
  async execute(
    sid: string,
    op: string,
    args: Record<string, unknown>,
    trafficToken?: string,
  ) {
    const connected = await Sandbox.connect(sid, { config: this.config });
    // connect preserves keep-alive and auto-resume behavior, but does not
    // return the create-only token needed by CubeProxy data-plane requests.
    const sb = trafficToken
      ? new Sandbox(
          { sandboxID: sid, trafficAccessToken: trafficToken },
          this.config,
        )
      : connected;
    const script = Buffer.from(remoteScript).toString("base64");
    const params = Buffer.from(JSON.stringify({ op, args })).toString("base64");
    const cmd = `python3 -c "import base64;exec(base64.b64decode('${script}'))" '${params}'`;
    const result = await sb.commands.run(cmd, {
      user: this.user,
      cwd: "/workspace",
      timeoutMs: 130000,
    });
    if (result.exitCode !== 0) {
      for (const code of [
        "SKILL_DIGEST_MISMATCH",
        "SKILL_IDENTITY_UNCONFIRMED",
      ])
        if (result.stderr.includes(code)) throw new Fault(409, code);
      throw new Fault(502, "REMOTE_TOOL_FAILED");
    }
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
