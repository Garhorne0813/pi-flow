import { z } from "zod";
import { AgentDefaults, Fault, audit } from "../domain/model.js";
import { skillZipLimits } from "../skills/packages.js";
import { PersonalService } from "../domain/personal-service.js";
import type { RouteContext } from "./context.js";

export function registerConfigurationRoutes({
  app,
  actor,
  service,
  sandbox,
  skillPackages,
  configurationStore,
}: Pick<
  RouteContext,
  | "app"
  | "actor"
  | "service"
  | "sandbox"
  | "skillPackages"
  | "configurationStore"
>) {
  for (const path of ["/admin/ui", "/admin/agents/ui"])
    app.get(path, async (_req, reply) =>
      reply.header("Cache-Control", "no-store").redirect("/admin/agents"),
    );
  app.get("/api/v1/admin/configuration", async (req, reply) => {
    const a = actor(req);
    const deployment = service.adminConfiguration(a);
    reply.header("Cache-Control", "no-store");
    const settings = await configurationStore.readMetadata(
      a.tenantId,
      ["agentDefaults", "defaultsRevision"],
      (s) => ({
        agentDefaults: s.agentDefaults,
        defaultsRevision: s.defaultsRevision ?? 0,
      }),
    );
    return {
      tenantId: a.tenantId,
      agentMode: service instanceof PersonalService ? "editable" : "versioned",
      agentsRevision:
        service instanceof PersonalService
          ? await service.registry.read((s) => s.configRevisions?.agents ?? 0)
          : undefined,
      deployment: {
        ...deployment,
        sandbox: sandbox.policy,
        editable: false,
        changesRequireRestart: true,
      },
      skillUploads: skillPackages?.configuration ?? {
        enabled: false,
        ...skillZipLimits,
      },
      defaultsRevision: settings.defaultsRevision,
      agentDefaults: settings.agentDefaults ?? {
        model:
          deployment.models[0] ??
          (process.env.HARNESS_MODE === "demo"
            ? { provider: "demo", modelId: "demo" }
            : { provider: "", modelId: "" }),
        tools: ["read", "ls", "grep", "find"],
        skillBundle: deployment.bundles[0] ?? "",
        maxSteps: 30,
        maxTokens: 100000,
        timeoutSeconds: 600,
        maxSubagents: 2,
        maxDepth: 1,
      },
      defaultsScope: "tenant-new-agent-drafts",
    };
  });
  app.put("/api/v1/admin/configuration/defaults", async (req) => {
    const a = actor(req);
    const deployment = service.adminConfiguration(a);
    const { expectedRevision, ...defaults } = AgentDefaults.extend({
      expectedRevision: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
    }).parse(req.body);
    if (
      deployment.modelApprovalRequired &&
      !deployment.models.some(
        (m) =>
          m.provider === defaults.model.provider &&
          m.modelId === defaults.model.modelId,
      )
    )
      throw new Fault(403, "MODEL_NOT_APPROVED");
    if (!service.hasBundle(defaults.skillBundle, a.tenantId))
      throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
    return configurationStore.tx(a.tenantId, (s) => {
      if ((s.defaultsRevision ?? 0) !== expectedRevision)
        throw new Fault(
          409,
          "DEFAULTS_CONFLICT",
          "Defaults were updated by another administrator",
        );
      s.agentDefaults = defaults;
      s.defaultsRevision = expectedRevision + 1;
      audit(s, a, "configuration.defaults", a.tenantId);
      return { agentDefaults: defaults, defaultsRevision: s.defaultsRevision };
    });
  });
}
