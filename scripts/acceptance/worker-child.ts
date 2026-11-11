import { PostgresStore } from "../../src/storage/store.js";
import { HarnessService } from "../../src/domain/service.js";
import { Worker } from "../../src/execution/worker.js";
import { DemoSandbox, SandboxManager } from "../../src/sandbox/manager.js";
import { MCPManager } from "../../src/mcp/manager.js";
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
