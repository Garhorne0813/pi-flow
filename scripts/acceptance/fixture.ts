import { readFile, readdir } from "node:fs/promises";
import { PostgresStore } from "../../src/store.js";
import { HarnessService } from "../../src/service.js";
import { AgentConfig, id } from "../../src/domain.js";
export async function fixture() {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error(
      "Dedicated TEST_DATABASE_URL required; never use production",
    );
  const store = new PostgresStore(process.env.TEST_DATABASE_URL);
  for (const name of (await readdir("migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await store.pool.query(await readFile(`migrations/${name}`, "utf8"));
  const actor = { tenantId: `acceptance-${id()}`, userId: "load", admin: true };
  const service = new HarnessService(store, [], ["default"]);
  const agent = await service.publish(
    actor,
    AgentConfig.parse({
      name: "acceptance",
      systemPrompt: "test",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
      skillBundle: "default",
    }),
  );
  const workspace = await service.createWorkspace(actor, "acceptance");
  const session = await service.createSession(actor, workspace.id, agent.id);
  const run = await service.submit(actor, session.id, "test", "acceptance");
  return {
    store,
    actor,
    service,
    run,
    async close() {
      await store.pool.query("DELETE FROM harness_tenants WHERE tenant_id=$1", [
        actor.tenantId,
      ]);
      await store.close();
    },
  };
}
