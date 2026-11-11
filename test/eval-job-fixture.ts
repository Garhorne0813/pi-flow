import { evalFixture, databaseUrl } from "./eval-fixture.js";
import { PostgresRegistry } from "../src/storage/registry.js";
import { MemoryStore } from "../src/storage/store.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { AgentConfig, Fault } from "../src/domain/model.js";
import { EvalService } from "../src/evals/service.js";
import { EvalAccess } from "../src/evals/access.js";
import { EvalJobStore } from "../src/evals/job-store.js";
export async function jobsFixture() {
  const f = await evalFixture(),
    registry = new PostgresRegistry(f.pool);
  const uid = await registry.identify("test", "u");
  await registry.tx((s) => {
    s.managedAgents = {
      assistant: {
        id: "assistant",
        enabled: true,
        updatedAt: new Date().toISOString(),
        config: AgentConfig.parse({
          name: "test",
          systemPrompt: "test",
          model: { provider: "demo", modelId: "demo" },
          tools: ["read"],
        }),
      },
    };
  });
  const actor = {
    tenantId: uid,
    userId: uid,
    issuer: "test",
    subject: "u",
    admin: false,
  };
  const access = new EvalAccess(
      new PersonalService(new MemoryStore(), registry),
      true,
    ),
    jobs = new EvalJobStore(f.pool, access),
    service = new EvalService(
      jobs,
      async (a) => registry.verifyIdentity(a.issuer!, a.subject!, a.userId),
      jobs,
    );
  const suite = await service.createSuite(actor, {
    name: "test",
    cases: [
      {
        caseId: "c",
        inputs: "hi",
        graders: [
          { id: "g", type: "exact", expected: "Demo harness response: hi" },
        ],
      },
    ],
  });
  await jobs.publish(uid, suite.id, 1);
  const request = { suiteId: suite.id, suiteVersion: 1, agentId: "assistant" };
  return { ...f, registry, actor, access, jobs, service, request };
}
