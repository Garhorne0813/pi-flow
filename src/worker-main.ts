import { bootstrap } from "./bootstrap.js";
const c = await bootstrap();
process.once("SIGTERM", () => {
  void c.worker.stop();
});
process.once("SIGINT", () => {
  void c.worker.stop();
});
await c.worker.start();
await c.store.close();
