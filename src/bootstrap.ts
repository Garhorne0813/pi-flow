import { ScheduleService } from "./schedules/service.js";
import { PersonalPostgresStore } from "./personal-postgres-store.js";
import { MemoryRegistry, PostgresRegistry } from "./store/registry.js";
import { personalStore } from "./store/personal.js";
import { PersonalService } from "./personal-service.js";
import { seedDemo } from "./config/agents.js";
import { z } from "zod";
import { HostSkillPackages, skillUploadRoot } from "./skill-packages.js";
import {
  SkillVolumeSchema,
  HostSkillRootsSchema,
  DEFAULT_HOST_SKILL_ROOTS,
  validateSkillBindings,
  validateHostSkillSource,
} from "./adapters/skill-mounts.js";
import { MemoryStore } from "./store.js";
import {
  CubeProvider,
  DemoSandbox,
  SandboxManager,
} from "./adapters/sandbox.js";
import { MCPManager } from "./adapters/mcp.js";
import { DemoRuntime, PiRuntime } from "./runtime.js";
import { Worker } from "./worker.js";
import { SandboxPolicySchema } from "./adapters/sandbox-policy.js";
export async function bootstrap() {
  const mode = process.env.HARNESS_MODE ?? "production";
  if (!["demo", "production"].includes(mode))
    throw new Error("Invalid HARNESS_MODE");
  const demo = mode === "demo";
  if (!demo && !process.env.DATABASE_URL)
    throw new Error("DATABASE_URL required");
  if (
    !demo &&
    (!process.env.CUBE_API_URL ||
      !process.env.CUBE_TEMPLATE_ID ||
      !process.env.CUBE_API_KEY ||
      !process.env.CUBE_VOLUME_DRIVER ||
      !process.env.CUBE_EXEC_USER)
  )
    throw new Error("Cube configuration required");
  if (process.env.SANDBOX_MULTI_SESSION === "true")
    throw new Error(
      "Multi-session sandbox leases are not supported by the current provider",
    );
  if (
    process.env.SANDBOX_NETWORK_MODE &&
    process.env.SANDBOX_NETWORK_MODE !== "unmanaged"
  )
    throw new Error(
      "Provider network enforcement is required for SANDBOX_NETWORK_MODE",
    );
  const backing = process.env.DATABASE_URL
    ? new PersonalPostgresStore(process.env.DATABASE_URL)
    : new MemoryStore();
  const registry =
    backing instanceof PersonalPostgresStore
      ? new PostgresRegistry(backing.pool)
      : new MemoryRegistry();
  if (
    !demo &&
    !(await registry.read((s) => s.modelCatalog?.length)) &&
    (!process.env.LLM_PROVIDER ||
      !process.env.LLM_MODEL_ID ||
      !process.env.LLM_API_KEY ||
      !process.env.LLM_BASE_URL)
  )
    throw new Error("Model catalog or LLM gateway configuration required");
  const store = personalStore(backing, registry);
  const bundles = z
    .record(z.string(), z.string().min(1))
    .parse(
      JSON.parse(
        process.env.SKILL_BUNDLES_JSON ?? (demo ? '{"default":"demo"}' : "{}"),
      ),
    );
  if (!Object.keys(bundles).length)
    throw new Error("Skill bundle mapping required");
  const hostSkillRoots = HostSkillRootsSchema.parse(
    JSON.parse(
      process.env.SKILL_HOST_ROOTS_JSON ??
        JSON.stringify(DEFAULT_HOST_SKILL_ROOTS),
    ),
  );
  const skillVolumes = z
    .record(z.string(), SkillVolumeSchema)
    .parse(JSON.parse(process.env.SKILL_VOLUMES_JSON ?? "{}"));
  validateSkillBindings(skillVolumes, hostSkillRoots);
  for (const binding of Object.values(skillVolumes))
    if ("hostPath" in binding) await validateHostSkillSource(binding.hostPath);
  for (const skill of Object.values(skillVolumes))
    if (!Object.hasOwn(bundles, skill.bundle))
      throw new Error("Unknown skill volume bundle");
  const uploadRoot = skillUploadRoot(
    hostSkillRoots,
    process.env.SKILL_UPLOAD_ROOT,
    skillVolumes,
  );
  const skillPackages = new HostSkillPackages(uploadRoot);
  const endpoints = z
    .record(
      z.string(),
      z.object({ url: z.url(), tokenEnv: z.string().optional() }).strict(),
    )
    .parse(JSON.parse(process.env.MCP_ENDPOINTS_JSON ?? "{}"));

  const grants = undefined;
  const selectedProvider =
    process.env.SANDBOX_PROVIDER ?? (demo ? "demo" : "cube");
  if (
    !["demo", "cube"].includes(selectedProvider) ||
    (!demo && selectedProvider === "demo")
  )
    throw new Error(`Unsupported SANDBOX_PROVIDER: ${selectedProvider}`);
  const provider = demo
    ? new DemoSandbox()
    : new CubeProvider(
        skillVolumes,
        process.env.CUBE_EXEC_USER!,
        process.env.CUBE_VOLUME_DRIVER!,
        hostSkillRoots,
        uploadRoot,
      );
  const service = new PersonalService(
    store,
    registry,
    Object.keys(endpoints),
    Object.keys(bundles),
    demo
      ? undefined
      : [
          {
            provider: process.env.LLM_PROVIDER!,
            modelId: process.env.LLM_MODEL_ID!,
          },
        ],
  );
  const sandbox = new SandboxManager(
    store,
    provider,
    SandboxPolicySchema.parse({
      maxActivePerUser: Number(process.env.SANDBOX_MAX_ACTIVE_PER_USER ?? 3),
      maxActiveTotal: Number(process.env.SANDBOX_MAX_ACTIVE_TOTAL ?? 100),
      idlePauseSeconds: Number(process.env.SANDBOX_IDLE_PAUSE_SECONDS ?? 900),
      idleReleaseSeconds: Number(
        process.env.SANDBOX_IDLE_RELEASE_SECONDS ?? 86400,
      ),
      sweepIntervalSeconds: Number(
        process.env.SANDBOX_SWEEP_INTERVAL_SECONDS ?? 60,
      ),
      maxSnapshotsPerWorkspace: Number(
        process.env.SANDBOX_MAX_SNAPSHOTS_PER_WORKSPACE ?? 20,
      ),
    }),
    (bundle, tenant) => service.hasBundle(bundle, tenant),
  );
  await sandbox.capacity.adoptLegacy();
  const mcp = new MCPManager(store, endpoints, grants);
  const runtime = demo ? new DemoRuntime() : await PiRuntime.create();
  const worker = new Worker(
    service,
    runtime,
    sandbox,
    mcp,
    z.coerce
      .number()
      .int()
      .min(1)
      .max(32)
      .parse(process.env.WORKER_CONCURRENCY ?? 4),
    5000,
    process.env.SCHEDULES_ENABLED === "true"
      ? new ScheduleService(service)
      : undefined,
  );
  if (demo) await registry.tx(seedDemo);
  return { store, service, sandbox, worker, mcp, skillPackages };
}
