import { bootstrap } from "./app/bootstrap.js";
import { telemetry } from "./observability/telemetry.js";
import { buildAPI } from "./api/server.js";
import { authFromEnv } from "./api/auth.js";
const auth = authFromEnv({ personal: true });
const context = await bootstrap();
const app = buildAPI(
  context.service,
  auth,
  context.sandbox,
  context.mcp,
  context.skillPackages,
  context.skillCollections,
);
const inline =
  process.env.HARNESS_MODE === "demo" || process.env.INLINE_WORKER === "true";
let loop: Promise<void> | undefined;
if (inline) loop = context.worker.start();
await app.listen({
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "127.0.0.1",
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await context.worker.stop();
  await loop;
  await app.close();
  await context.store.close();
}
process.once("SIGTERM", () => {
  void close().catch((e) => {
    telemetry.error("api_shutdown", e);
    process.exitCode = 1;
  });
});
process.once("SIGINT", () => {
  void close().catch((e) => {
    telemetry.error("api_shutdown", e);
    process.exitCode = 1;
  });
});
