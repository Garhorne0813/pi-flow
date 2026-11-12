import type pg from "pg";
import { Fault, emptyState } from "../domain/model.js";
import { freezeDataset } from "./dataset.js";
import type { EvalStore, Suite, SuiteVersion, Page } from "./store.js";
export class PostgresEvalStore implements EvalStore {
  constructor(readonly pool: pg.Pool) {}
  async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async listSuites(user: string, p: Page) {
    return (
      await this.pool.query(
        "SELECT data-'cases' AS data FROM personal_eval_suites WHERE user_id=$1 AND NOT deleted ORDER BY suite_id LIMIT $2 OFFSET $3",
        [user, p.limit, p.offset],
      )
    ).rows.map((r) => r.data);
  }
  async getSuite(user: string, id: string): Promise<Suite> {
    const r = await this.pool.query(
      "SELECT data FROM personal_eval_suites WHERE user_id=$1 AND suite_id=$2 AND NOT deleted",
      [user, id],
    );
    if (!r.rows[0]) throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
    return r.rows[0].data;
  }
  async createSuite(s: Suite) {
    await this.transaction(async (c) => {
      await c.query(
        "INSERT INTO personal_user_state(user_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [s.userId, JSON.stringify(emptyState())],
      );
      await c.query(
        "INSERT INTO personal_eval_suites(user_id,suite_id,data) VALUES($1,$2,$3)",
        [s.userId, s.id, JSON.stringify(s)],
      );
    });
    return s;
  }
  async patchSuite(
    user: string,
    id: string,
    revision: number,
    patch: Pick<Suite, "name" | "description" | "cases">,
  ): Promise<Suite> {
    return this.transaction(async (c) => {
      const row = (
        await c.query(
          "SELECT data FROM personal_eval_suites WHERE user_id=$1 AND suite_id=$2 AND NOT deleted FOR UPDATE",
          [user, id],
        )
      ).rows[0];
      if (!row) throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
      const s: Suite = row.data;
      if (s.draftRevision !== revision)
        throw new Fault(409, "EVAL_DRAFT_CONFLICT");
      const next = {
        ...s,
        ...patch,
        draftRevision: revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await c.query(
        "UPDATE personal_eval_suites SET data=$3 WHERE user_id=$1 AND suite_id=$2",
        [user, id, JSON.stringify(next)],
      );
      return next;
    });
  }
  async deleteSuite(user: string, id: string) {
    const r = await this.pool.query(
      "UPDATE personal_eval_suites SET deleted=true WHERE user_id=$1 AND suite_id=$2 AND NOT deleted",
      [user, id],
    );
    if (!r.rowCount) throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
  }
  async publish(
    user: string,
    id: string,
    revision: number,
  ): Promise<SuiteVersion> {
    return this.transaction(async (c) => {
      const row = (
        await c.query(
          "SELECT data FROM personal_eval_suites WHERE user_id=$1 AND suite_id=$2 AND NOT deleted FOR UPDATE",
          [user, id],
        )
      ).rows[0];
      if (!row) throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
      const s: Suite = row.data;
      if (s.draftRevision !== revision)
        throw new Fault(409, "EVAL_DRAFT_CONFLICT");
      if (!s.cases.length) throw new Fault(400, "EVAL_EMPTY_SUITE");
      const frozen = freezeDataset(s.cases);
      const v = {
        suiteId: id,
        version: s.currentVersion + 1,
        specDigest: frozen.specDigest,
        createdAt: new Date().toISOString(),
        createdBy: user,
      };
      await c.query(
        "INSERT INTO personal_eval_suite_versions(user_id,suite_id,version,data) VALUES($1,$2,$3,$4)",
        [user, id, v.version, JSON.stringify(v)],
      );
      for (const [position, item] of frozen.cases.entries())
        await c.query(
          "INSERT INTO personal_eval_cases(user_id,suite_id,version,case_id,position,data) VALUES($1,$2,$3,$4,$5,$6)",
          [user, id, v.version, item.caseId, position, JSON.stringify(item)],
        );
      s.currentVersion = v.version;
      s.draftRevision++;
      s.updatedAt = v.createdAt;
      await c.query(
        "UPDATE personal_eval_suites SET data=$3 WHERE user_id=$1 AND suite_id=$2",
        [user, id, JSON.stringify(s)],
      );
      return v;
    });
  }
  async versions(user: string, id: string, p: Page) {
    const suite = await this.pool.query(
      "SELECT 1 FROM personal_eval_suites WHERE user_id=$1 AND suite_id=$2",
      [user, id],
    );
    if (!suite.rowCount) throw new Fault(404, "EVAL_SUITE_NOT_FOUND");
    return (
      await this.pool.query(
        "SELECT data FROM personal_eval_suite_versions WHERE user_id=$1 AND suite_id=$2 ORDER BY version DESC LIMIT $3 OFFSET $4",
        [user, id, p.limit, p.offset],
      )
    ).rows.map((r) => r.data);
  }
  async version(
    user: string,
    id: string,
    version: number,
  ): Promise<SuiteVersion> {
    const row = (
      await this.pool.query(
        "SELECT data FROM personal_eval_suite_versions WHERE user_id=$1 AND suite_id=$2 AND version=$3",
        [user, id, version],
      )
    ).rows[0];
    if (!row) throw new Fault(404, "EVAL_VERSION_NOT_FOUND");
    return row.data;
  }
  async cases(user: string, id: string, version: number, p: Page) {
    await this.version(user, id, version);
    return (
      await this.pool.query(
        "SELECT data FROM personal_eval_cases WHERE user_id=$1 AND suite_id=$2 AND version=$3 ORDER BY position LIMIT $4 OFFSET $5",
        [user, id, version, p.limit, p.offset],
      )
    ).rows.map((r) => r.data);
  }
}
