import { JudgeGateway } from "./evals/judge.js";
import { PersonalPostgresStore } from "./storage/personal-postgres-store.js";
import { PostgresRegistry } from "./storage/registry.js";
import { personalStore } from "./storage/personal.js";
import { PersonalService } from "./domain/personal-service.js";
import { PiRuntime } from "./execution/runtime.js";
import { EvalExecutor } from "./evals/executor.js";
import { EvalWorker, EvalDemoRuntime } from "./evals/worker.js";
import { createEvals } from "./evals/factory.js";
if (
  process.env.EVALS_ENABLED !== "true" ||
  process.env.EVAL_WORKER_ENABLED !== "true"
)
  throw new Error("Eval Worker disabled");
if (!process.env.DATABASE_URL)
  throw new Error("Eval Worker requires PostgreSQL");
if (process.env.EVAL_ALLOW_READONLY_SANDBOX === "true")
  throw new Error("Readonly provider isolation has not been accepted");
const store = new PersonalPostgresStore(process.env.DATABASE_URL);
await store.ready();
const registry = new PostgresRegistry(store.pool),
  service = new PersonalService(personalStore(store, registry), registry);
const demo = process.env.HARNESS_MODE === "demo",
  evals = createEvals(service, store, demo);
const runtime = demo ? new EvalDemoRuntime() : await PiRuntime.create();
const worker = new EvalWorker(
  evals.jobs!,
  new EvalExecutor(runtime),
  new JudgeGateway(evals.jobs!, runtime).grade,
);
process.once("SIGTERM", () => worker.stop());
process.once("SIGINT", () => worker.stop());
try {
  await worker.start();
} finally {
  await store.close();
}
