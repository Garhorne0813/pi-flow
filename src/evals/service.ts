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
  ) {}
  async authorize(a: Actor) {
    if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
      throw new Fault(401, "AUTHENTICATION_EXPIRED");
    await this.verifyActor(a);
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
    const input = SuiteDraft.extend({
      revision: z.number().int().positive(),
    }).parse(raw);
    return this.store.patchSuite(a.userId, sid, input.revision, {
      name: input.name,
      description: input.description,
      cases: input.cases,
    });
  }
}
