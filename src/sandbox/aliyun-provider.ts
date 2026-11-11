import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import {
  Sandbox,
  SandboxNotFoundError,
  CommandExitError,
  type SandboxConnectOpts,
} from "e2b";
import { Fault, type Skill } from "../domain/model.js";
import { skillMountPath, skillScope } from "./skill-mounts.js";
import { SandboxCreationError, type SandboxProvider } from "./provider.js";
import { runRemoteTool } from "./remote-tool.js";
import {
  uploadedOssSkillBinding,
  storageOverlaps,
} from "../skills/oss-storage.js";

const directory = z
  .string()
  .refine(
    (p) =>
      p.startsWith("/") &&
      p !== "/" &&
      posix.normalize(p) === p &&
      !p.endsWith("/") &&
      !/[\s\\\x00-\x1f]/.test(p),
    "Expected a canonical absolute storage subdirectory",
  );
const httpsUrl = z.url().refine((v) => {
  const u = new URL(v);
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    u.pathname === "/"
  );
}, "Expected an HTTPS origin");
export const AliyunConfigSchema = z
  .object({
    apiKey: z.string().min(1),
    apiUrl: httpsUrl,
    domain: z.string().regex(/^[a-zA-Z0-9.-]+$/),
    template: z.string().min(1),
    user: z
      .string()
      .regex(/^[a-z_][a-z0-9_-]*$/)
      .refine((v) => v !== "root"),
    timeoutMs: z.number().int().min(180000).max(86400000).default(900000),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    endpoint: httpsUrl,
    roleArn: z.string().regex(/^acs:ram::[0-9]+:role\/[a-zA-Z0-9_/-]+$/),
    workspacePrefix: directory.default("/pi-flow/workspaces"),
    skillUploadPrefix: directory.default("/pi-flow/skill-uploads"),
    allowInternetAccess: z.boolean().default(false),
    network: z
      .object({
        allowOut: z.array(z.string().min(1)).optional(),
        denyOut: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .default({}),
    // Each published version includes SKILL.md and its auxiliary files. These
    // are OSS paths, never Cube volume IDs or local host directories.
    skills: z
      .record(
        z.string(),
        z
          .object({
            bundle: z.string().min(1),
            path: z
              .string()
              .regex(/^\/skills\/(?:[a-zA-Z0-9_-]+\/)+SKILL\.md$/),
            bucketPath: directory,
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export type AliyunConfig = z.infer<typeof AliyunConfigSchema>;

export function aliyunConfig(
  env: NodeJS.ProcessEnv = process.env,
): AliyunConfig {
  return AliyunConfigSchema.parse({
    apiKey: env.E2B_API_KEY,
    apiUrl: env.E2B_API_URL,
    domain: env.E2B_DOMAIN,
    template: env.ALIYUN_TEMPLATE_ID,
    user: env.ALIYUN_EXEC_USER,
    timeoutMs:
      env.ALIYUN_TIMEOUT_MS === undefined
        ? undefined
        : Number(env.ALIYUN_TIMEOUT_MS),
    bucket: env.ALIYUN_OSS_BUCKET,
    endpoint: env.ALIYUN_OSS_ENDPOINT,
    roleArn: env.ALIYUN_OSS_ROLE_ARN,
    workspacePrefix: env.ALIYUN_OSS_WORKSPACE_PREFIX,
    skillUploadPrefix: env.ALIYUN_OSS_SKILL_UPLOAD_PREFIX,
    allowInternetAccess:
      env.ALIYUN_ALLOW_INTERNET_ACCESS === undefined
        ? undefined
        : z.enum(["true", "false"]).parse(env.ALIYUN_ALLOW_INTERNET_ACCESS) ===
          "true",
    network: JSON.parse(env.ALIYUN_NETWORK_JSON ?? "{}"),
    skills: JSON.parse(env.ALIYUN_SKILLS_JSON ?? "{}"),
  });
}

export class AliyunE2BProvider implements SandboxProvider {
  readonly supportsPause = false;
  readonly supportsSnapshots = false;
  readonly supportsSnapshotClone = false;
  // commands/files use envdAccessToken, supplied by E2B connect. The traffic
  // token protects user service ports and is not required for these tools.
  private readonly options: SandboxConnectOpts;
  private readonly volumePrefix: string;
  private readonly config: AliyunConfig;

  constructor(config: AliyunConfig) {
    this.config = AliyunConfigSchema.parse(config);
    this.options = {
      apiKey: this.config.apiKey,
      apiUrl: this.config.apiUrl,
      domain: this.config.domain,
      validateApiKey: false,
      requestTimeoutMs: 20000,
      timeoutMs: this.config.timeoutMs,
    };
    const namespace = createHash("sha256")
      .update(
        JSON.stringify([
          this.config.bucket,
          this.config.endpoint,
          this.config.workspacePrefix,
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    this.volumePrefix = `aliyun-oss:${namespace}:`;
    if (
      storageOverlaps(
        this.config.skillUploadPrefix,
        this.config.workspacePrefix,
      )
    )
      throw new Error(
        "OSS Skill uploads must be separate from workspace storage",
      );
    for (const binding of Object.values(this.config.skills)) {
      const a = binding.bucketPath,
        b = this.config.workspacePrefix;
      if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
        throw new Error(
          "Aliyun skill storage must be separate from workspace storage",
        );
      if (storageOverlaps(a, this.config.skillUploadPrefix))
        throw new Error(
          "Manual Aliyun Skill sources must not overlap the upload namespace",
        );
    }
  }
  private workspacePath(volume: string) {
    const name = volume.slice(this.volumePrefix.length);
    if (
      !volume.startsWith(this.volumePrefix) ||
      !/^ws-[a-zA-Z0-9_-]{1,128}$/.test(name)
    )
      throw new Fault(409, "SANDBOX_STORAGE_PROVIDER_MISMATCH");
    return `${this.config.workspacePrefix}/${name}`;
  }
  async createVolume(name: string) {
    const volume = this.volumePrefix + name;
    this.workspacePath(volume);
    // OSS creates the prefix on first write. No incompatible E2B Volume API.
    return volume;
  }
  private binding(
    skill: Pick<Skill, "id" | "bundle" | "path" | "hostUpload" | "ossUpload">,
  ) {
    return (
      uploadedOssSkillBinding(skill, this.config) ??
      (Object.hasOwn(this.config.skills, skill.id)
        ? this.config.skills[skill.id]
        : undefined)
    );
  }
  scope(bundle: string, skills: readonly Skill[]) {
    const identity = skillScope(bundle, skills);
    const bindings = [...skills]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((skill) => {
        const binding = this.binding(skill);
        if (
          !binding ||
          binding.bundle !== bundle ||
          binding.path !== skill.path
        )
          throw new Fault(403, "ALIYUN_SKILL_NOT_PUBLISHED");
        return { id: skill.id, ...binding };
      });
    return createHash("sha256")
      .update(
        JSON.stringify({
          provider: "aliyun",
          identity,
          bindings,
          storage: this.volumePrefix,
          role: this.config.roleArn,
          template: this.config.template,
          user: this.config.user,
          network: this.config.network,
          internet: this.config.allowInternetAccess,
        }),
      )
      .digest("hex");
  }
  async create(
    volume: string,
    bundle: string,
    skills: readonly Skill[],
    snapshotId?: string,
    operation?: string,
  ) {
    let scope: string, bucketPath: string;
    try {
      if (snapshotId) throw new Fault(409, "SANDBOX_SNAPSHOT_UNSUPPORTED");
      scope = this.scope(bundle, skills);
      bucketPath = this.workspacePath(volume);
    } catch (error) {
      throw new SandboxCreationError(error, true);
    }
    const mount = (
      mountDir: string,
      bucketPath: string,
      readOnly: boolean,
    ) => ({
      bucketName: this.config.bucket,
      endpoint: this.config.endpoint,
      mountDir,
      bucketPath,
      readOnly,
    });
    const sb = await Sandbox.create(this.config.template, {
      ...this.options,
      secure: true,
      allowInternetAccess: this.config.allowInternetAccess,
      network: { ...this.config.network, allowPublicTraffic: false },
      metadata: {
        "fc.sandbox.auth.role": this.config.roleArn,
        "fc.sandbox.storage.oss": JSON.stringify({
          mountPoints: [
            mount("/workspace", bucketPath, false),
            ...skills.map((s) =>
              mount(skillMountPath(s), this.binding(s)!.bucketPath, true),
            ),
          ],
        }),
        harnessWorkspaceVolume: volume,
        harnessSkillBundle: bundle,
        harnessSkillScope: scope,
        ...(operation ? { harnessOperation: operation } : {}),
      },
    });
    try {
      // A template or service that ignores mounts must never silently write
      // into ephemeral storage or expose writable Skill directories.
      await this.run(sb, "ls", {
        path: "/workspace",
        _requireWorkspaceMount: true,
        _hostSkillMounts: skills.map(skillMountPath),
        _skillManifests: skills.map((s) => ({
          path: s.path,
          digest: s.digest,
        })),
      });
    } catch (error) {
      try {
        await this.kill(sb.sandboxId);
      } catch (cleanup) {
        throw new SandboxCreationError(error, false, sb.sandboxId, cleanup);
      }
      throw new SandboxCreationError(error, true, sb.sandboxId);
    }
    return { sandboxId: sb.sandboxId, trafficToken: sb.trafficAccessToken };
  }
  private async connected(sid: string) {
    try {
      return await Sandbox.connect(sid, this.options);
    } catch (error) {
      if (error instanceof SandboxNotFoundError)
        throw new Fault(410, "SANDBOX_GONE");
      throw error;
    }
  }
  async connect(sid: string) {
    await this.connected(sid);
  }
  async execute(sid: string, op: string, args: Record<string, unknown>) {
    const manifests = Array.isArray(args._skillManifests)
      ? (args._skillManifests as { path: string; digest: string }[])
      : [];
    const ids = Array.isArray(args._skillIds)
      ? (args._skillIds as string[])
      : [];
    const mounts = ids.map((id) => {
      // Only SandboxManager may supply upload metadata from the authorized
      // tenant's registry. Browser tool arguments are overwritten at dispatch.
      const uploaded = (
        Array.isArray(args._skillOssUploads) ? args._skillOssUploads : []
      ).find((value: Pick<Skill, "id">) => value.id === id) as
        | Pick<Skill, "id" | "bundle" | "path" | "hostUpload" | "ossUpload">
        | undefined;
      const binding = uploaded
        ? this.binding(uploaded)
        : Object.hasOwn(this.config.skills, id)
          ? this.config.skills[id]
          : undefined;
      if (!binding || !manifests.some((m) => m.path === binding.path))
        throw new Fault(403, "ALIYUN_SKILL_NOT_PUBLISHED");
      return binding.path.slice(0, -"/SKILL.md".length);
    });
    return this.run(await this.connected(sid), op, {
      ...args,
      _requireWorkspaceMount: true,
      _hostSkillMounts: mounts,
    });
  }
  private run(sb: Sandbox, op: string, args: Record<string, unknown>) {
    return runRemoteTool(
      async (command) => {
        try {
          return await sb.commands.run(command, {
            user: this.config.user,
            cwd: "/workspace",
            timeoutMs: 130000,
          });
        } catch (error) {
          if (error instanceof CommandExitError) return error;
          throw error;
        }
      },
      op,
      args,
    );
  }
  async kill(sid: string) {
    // Static control-plane kill never connects or resumes an instance. Keep
    // apiUrl on the options object, including for private/custom endpoints.
    try {
      await Sandbox.kill(sid, this.options);
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
  }
  async pause(_sid: string): Promise<void> {
    throw new Fault(409, "SANDBOX_PAUSE_UNSUPPORTED");
  }
  async snapshot(_sid: string, _name?: string): Promise<string> {
    throw new Fault(409, "SANDBOX_SNAPSHOT_UNSUPPORTED");
  }
  async deleteSnapshot(_id: string): Promise<void> {
    throw new Fault(409, "SANDBOX_SNAPSHOT_UNSUPPORTED");
  }
  async destroyVolume(volume: string) {
    this.workspacePath(volume);
    // External OSS data is retained. Configure bucket lifecycle or explicitly
    // delete this workspace's prefix after the application workspace is gone.
  }
}
