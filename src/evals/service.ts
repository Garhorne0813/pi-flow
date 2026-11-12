import type { EvalJobStore } from "./job-store.js";
import type { EvalJob } from "./jobs.js";
import { z } from "zod";
import { id, Fault, type Actor } from "../domain/model.js";
import type { EvalStore } from "./store.js";
import { CaseList } from "./dataset.js";
export const SuiteDraft = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(""),
    cases: CaseList.default([]),
  })
  .strict();
export const Page = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export class EvalService {
  constructor(
    readonly store: EvalStore,
    readonly verifyActor: (a: Actor) => Promise<void>,
    readonly jobs?: EvalJobStore,
  ) {}
  async authorize(a: Actor) {
    if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
      throw new Fault(401, "AUTHENTICATION_EXPIRED");
    await this.verifyActor(a);
  }
  jobStore() {
    if (!this.jobs) throw new Fault(503, "EVAL_POSTGRES_REQUIRED");
    return this.jobs;
  }
  async authorizeJob(a: Actor, id: string) {
    await this.authorize(a);
    const job = await this.jobStore().job(a.userId, id);
    await this.jobStore().access.authorize(job);
    return job;
  }
  async listJobs(a: Actor, page: z.infer<typeof Page>) {
    await this.authorize(a);
    const store = this.jobStore(),
      visible: EvalJob[] = [];
    let authorizedOffset = 0;
    for (let offset = 0; ; offset += 100) {
      const rows = await store.jobs(a.userId, { offset, limit: 100 });
      for (const job of rows) {
        try {
          await store.access.authorize(job);
        } catch (error) {
          if (error instanceof Fault && error.status === 403) continue;
          throw error;
        }
        if (authorizedOffset++ < page.offset) continue;
        visible.push(job);
        if (visible.length === page.limit) return visible;
      }
      if (rows.length < 100) return visible;
    }
  }
  async createSuite(a: Actor, raw: unknown) {
    await this.authorize(a);
    const draft = SuiteDraft.parse(raw),
      now = new Date().toISOString();
    return this.store.createSuite({
      ...draft,
      id: id(),
      userId: a.userId,
      currentVersion: 0,
      draftRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  async patchSuite(a: Actor, sid: string, raw: unknown) {
    await this.authorize(a);
    const input = z
      .object({
        revision: z.number().int().positive(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(2000).optional(),
        cases: CaseList.optional(),
      })
      .strict()
      .parse(raw);
    const previous = await this.store.getSuite(a.userId, sid);
    return this.store.patchSuite(a.userId, sid, input.revision, {
      name: input.name ?? previous.name,
      description: input.description ?? previous.description,
      cases: input.cases ?? previous.cases,
    });
  }
}
