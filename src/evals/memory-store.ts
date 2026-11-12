import { Fault } from "../domain/model.js";
import { freezeDataset } from "./dataset.js";
import type { EvalStore, Suite, SuiteVersion, Page } from "./store.js";
export class MemoryEvalStore implements EvalStore {
  private suites = new Map<string, Suite>();
  private snapshots = new Map<
    string,
    { meta: SuiteVersion; cases: Suite["cases"] }
  >();
  private deleted = new Set<string>();
  private key(user: string, id: string) {
    return JSON.stringify([user, id]);
  }
  private versionKey(user: string, id: string, v: number) {
    return JSON.stringify([user, id, v]);
  }
  async listSuites(user: string, p: Page) {
    return structuredClone(
      [...this.suites.values()]
        .filter(
          (s) => s.userId === user && !this.deleted.has(this.key(user, s.id)),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(p.offset, p.offset + p.limit)
        .map(({ cases, ...s }) => s),
    );
  }
  async getSuite(user: string, id: string) {
    const s = this.suites.get(this.key(user, id));
    if (!s || this.deleted.has(this.key(user, id)))
      throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
    return structuredClone(s);
  }
  async createSuite(s: Suite) {
    this.suites.set(this.key(s.userId, s.id), structuredClone(s));
    return structuredClone(s);
  }
  async patchSuite(
    user: string,
    id: string,
    revision: number,
    patch: Pick<Suite, "name" | "description" | "cases">,
  ) {
    const key = this.key(user, id),
      s = this.suites.get(key);
    if (!s || this.deleted.has(key))
      throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
    if (s.draftRevision !== revision)
      throw new Fault(409, "EVAL_DRAFT_CONFLICT");
    const next = {
      ...s,
      ...structuredClone(patch),
      draftRevision: revision + 1,
      updatedAt: new Date().toISOString(),
    };
    this.suites.set(key, next);
    return structuredClone(next);
  }
  async deleteSuite(user: string, id: string) {
    await this.getSuite(user, id);
    this.deleted.add(this.key(user, id));
  }
  async publish(user: string, id: string, revision: number) {
    const s = this.suites.get(this.key(user, id));
    if (!s || this.deleted.has(this.key(user, id)))
      throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
    if (s.draftRevision !== revision)
      throw new Fault(409, "EVAL_DRAFT_CONFLICT");
    if (!s.cases.length) throw new Fault(400, "EVAL_EMPTY_SUITE");
    const frozen = freezeDataset(s.cases),
      meta = {
        suiteId: id,
        version: ++s.currentVersion,
        specDigest: frozen.specDigest,
        createdAt: new Date().toISOString(),
        createdBy: user,
      };
    s.draftRevision++;
    s.updatedAt = meta.createdAt;
    this.snapshots.set(this.versionKey(user, id, meta.version), {
      meta,
      cases: frozen.cases,
    });
    return structuredClone(meta);
  }
  async versions(user: string, id: string, p: Page) {
    await this.getSuite(user, id);
    return structuredClone(
      [...this.snapshots.entries()]
        .filter(([k]) => {
          const parts = JSON.parse(k);
          return parts[0] === user && parts[1] === id;
        })
        .map(([, v]) => v.meta)
        .sort((a, b) => b.version - a.version)
        .slice(p.offset, p.offset + p.limit),
    );
  }
  async version(user: string, id: string, v: number) {
    const s = this.snapshots.get(this.versionKey(user, id, v));
    if (!s) throw new Fault(404, "EVAL_VERSION_NOT_FOUND");
    return structuredClone(s.meta);
  }
  async cases(user: string, id: string, v: number, p: Page) {
    await this.version(user, id, v);
    return structuredClone(
      this.snapshots
        .get(this.versionKey(user, id, v))!
        .cases.slice(p.offset, p.offset + p.limit),
    );
  }
}
