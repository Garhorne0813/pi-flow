import { bootstrap } from "./app/bootstrap.js";
import { telemetry } from "./observability/telemetry.js";
const c = await bootstrap();
process.once("SIGTERM", () => {
  void c.worker.stop().catch((e) => {
    telemetry.error("worker_shutdown", e, { workerId: c.worker.owner });
    process.exitCode = 1;
  });
});
process.once("SIGINT", () => {
  void c.worker.stop().catch((e) => {
    telemetry.error("worker_shutdown", e, { workerId: c.worker.owner });
    process.exitCode = 1;
  });
});
await c.worker.start();
await c.store.close();
