import { bootstrap } from "./bootstrap.js";
import { SandboxReconciler } from "./sandbox-reconciler.js";
const ctx = await bootstrap();
try {
  console.log(
    JSON.stringify(await new SandboxReconciler(ctx.store, ctx.sandbox).scan()),
  );
} finally {
  await ctx.store.close();
}
