import { PostgresStore } from "../../src/store.js";
import { HarnessService } from "../../src/service.js";
import { Worker } from "../../src/worker.js";
import { DemoSandbox, SandboxManager } from "../../src/adapters/sandbox.js";
import { MCPManager } from "../../src/adapters/mcp.js";
const store = new PostgresStore(process.env.TEST_DATABASE_URL!);
const worker = new Worker(
  new HarnessService(store, [], ["default"]),
  {
    async execute(ctx) {
      await ctx.checkpoint([{ acceptance: "durable-before-crash" }]);
      process.send?.({ type: "executing" });
      await new Promise<void>(() => {});
    },
  },
  new SandboxManager(store, new DemoSandbox()),
  new MCPManager(store, {}),
);
process.on("message", async (message) => {
  if (message === "tick") {
    try {
      await worker.tick();
      process.send?.({ type: "ticked" });
    } catch {
      process.send?.({ type: "error" });
    }
  }
});
process.send?.({ type: "ready" });
