import { z } from "zod";
import { MemoryStore, PostgresStore } from "./store.js";
import { HarnessService } from "./service.js";
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
    (!process.env.LLM_PROVIDER ||
      !process.env.LLM_MODEL_ID ||
      !process.env.LLM_API_KEY ||
      !process.env.LLM_BASE_URL)
  )
    throw new Error("Enterprise model gateway configuration required");
  if (
    !demo &&
    (!process.env.CUBE_API_URL ||
      !process.env.CUBE_TEMPLATE_ID ||
      !process.env.CUBE_API_KEY ||
      !process.env.CUBE_VOLUME_DRIVER ||
      !process.env.CUBE_EXEC_USER)
  )
    throw new Error("Cube configuration required");
  const store = process.env.DATABASE_URL
    ? new PostgresStore(process.env.DATABASE_URL)
    : new MemoryStore();
  const bundles = z
    .record(z.string(), z.string().min(1))
    .parse(
      JSON.parse(
        process.env.SKILL_BUNDLES_JSON ?? (demo ? '{"default":"demo"}' : "{}"),
      ),
    );
  if (!Object.keys(bundles).length)
    throw new Error("Skill bundle mapping required");
  const skillVolumes = z
    .record(
      z.string(),
      z
        .object({
          bundle: z.string().min(1),
          path: z.string().regex(/^\/skills\/(?:[a-zA-Z0-9_-]+\/)+SKILL\.md$/),
          volume: z.string().min(1),
        })
        .strict(),
    )
    .parse(JSON.parse(process.env.SKILL_VOLUMES_JSON ?? "{}"));
  for (const skill of Object.values(skillVolumes))
    if (!Object.hasOwn(bundles, skill.bundle))
      throw new Error("Unknown skill volume bundle");
  const endpoints = z
    .record(
      z.string(),
      z.object({ url: z.url(), tokenEnv: z.string().optional() }).strict(),
    )
    .parse(JSON.parse(process.env.MCP_ENDPOINTS_JSON ?? "{}"));
  if (!demo && !process.env.TENANT_CAPABILITIES_JSON)
    throw new Error("Explicit tenant capability grants required");
  const grants = demo
    ? undefined
    : z
        .record(
          z.string(),
          z
            .object({
              bundles: z.array(z.string()),
              endpoints: z.array(z.string()),
            })
            .strict(),
        )
        .parse(JSON.parse(process.env.TENANT_CAPABILITIES_JSON!));
  const provider = demo
    ? new DemoSandbox()
    : new CubeProvider(
        skillVolumes,
        process.env.CUBE_EXEC_USER!,
        process.env.CUBE_VOLUME_DRIVER!,
      );
  const service = new HarnessService(
    store,
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
    grants,
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
  );
  if (demo)
    await store.tx("demo", (s) => {
      if (!Object.values(s.agents).length)
        s.agents["00000000-0000-4000-8000-000000000001"] = {
          id: "00000000-0000-4000-8000-000000000001",
          enabled: true,
          publishedAt: new Date().toISOString(),
          digest: "demo",
          config: {
            name: "Demo Agent",
            systemPrompt: "Demo",
            agentsMd: [],
            model: { provider: "demo", modelId: "demo" },
            tools: ["read", "write", "ls"],
            skills: [],
            mcpServers: [],
            subagents: [],
            skillBundle: "default",
            maxTokens: 100000,
            maxSteps: 30,
            timeoutSeconds: 600,
            maxSubagents: 2,
            maxDepth: 1,
          },
        };
    });
  return { store, service, sandbox, worker, mcp };
}
