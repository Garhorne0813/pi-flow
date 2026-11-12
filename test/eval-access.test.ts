import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryRegistry } from "../src/storage/registry.js";
import { MemoryStore } from "../src/storage/store.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { AgentConfig } from "../src/domain/model.js";
import { EvalAccess } from "../src/evals/access.js";
import { JobRequest, type EvalJob } from "../src/evals/jobs.js";
test("rotating target or Judge gateway approval invalidates retained frozen refs before secret access", async () => {
  const registry = new MemoryRegistry(),
    userId = await registry.identify("test", "user");
  const actor = {
    tenantId: userId,
    userId,
    issuer: "test",
    subject: "user",
    admin: false,
  };
  const config = AgentConfig.parse({
    name: "agent",
    systemPrompt: "",
    model: { provider: "test", modelId: "target" },
    tools: [],
  });
  await registry.tx((s) => {
    s.managedAgents = {
      assistant: {
        id: "assistant",
        enabled: true,
        updatedAt: new Date().toISOString(),
        config,
      },
    };
    s.modelCatalog = ["target", "judge"].map((modelId) => ({
      provider: "test",
      modelId,
      baseUrl: "https://example.com/v1",
      secretRef: "placeholder",
      default: false,
      gatewayRef: modelId + "-old",
    }));
    s.modelGatewayVersions = Object.fromEntries(
      ["target", "judge"].map((modelId) => [
        modelId + "-old",
        {
          model: { provider: "test", modelId },
          baseUrl: "https://example.com/v1",
          secretVersion: "not-needed",
        },
      ]),
    );
  });
  const access = new EvalAccess(
    new PersonalService(new MemoryStore(), registry),
  );
  const snapshot = await access.snapshot(actor, "assistant");
  const j: EvalJob = {
    jobId: randomUUID(),
    userId,
    actor,
    request: JobRequest.parse({
      suiteId: randomUUID(),
      suiteVersion: 1,
      agentId: "assistant",
    }),
    requestDigest: "r",
    configDigest: "c",
    suiteDigest: "s",
    snapshot,
    state: "QUEUED",
    createdAt: new Date().toISOString(),
  };
  snapshot.judge = {
    config: { ...config, model: { provider: "test", modelId: "judge" } },
    gatewayRef: "judge-old",
    version: "frozen",
  };
  await access.authorize(j, undefined, true);
  for (const role of ["target", "judge"]) {
    await registry.tx((s) => {
      for (const m of s.modelCatalog!)
        m.gatewayRef = m.modelId === role ? role + "-new" : m.modelId + "-old";
    });
    await assert.rejects(
      access.authorize(j, undefined, true),
      /EVAL_GATEWAY_REVOKED/,
    );
    await access.authorize(j);
    await assert.rejects(
      access.gateway(role === "judge" ? snapshot.judge! : snapshot),
      /EVAL_GATEWAY_REVOKED/,
    );
    assert.equal(
      await registry.read((s) =>
        Boolean(s.modelGatewayVersions![role + "-old"]),
      ),
      true,
    );
  }
});
