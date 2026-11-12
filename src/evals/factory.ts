import { PersonalPostgresStore } from "../storage/personal-postgres-store.js";
import type { Store } from "../storage/store.js";
import type { PersonalService } from "../domain/personal-service.js";
import { EvalAccess } from "./access.js";
import { EvalJobStore } from "./job-store.js";
import { MemoryEvalStore } from "./memory-store.js";
import { EvalService } from "./service.js";
export function createEvals(
  service: PersonalService,
  backing: Store,
  demo: boolean,
) {
  const jobs =
    backing instanceof PersonalPostgresStore
      ? new EvalJobStore(backing.pool, new EvalAccess(service, demo))
      : undefined;
  return new EvalService(
    jobs ?? new MemoryEvalStore(),
    (a) => service.verifyActor(a),
    jobs,
  );
}
