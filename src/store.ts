import pg from "pg";
import { emptyState, type State } from "./domain.js";
export interface Store {
  tx<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  tenants(): Promise<string[]>;
  close(): Promise<void>;
}
export class MemoryStore implements Store {
  private states = new Map<string, State>();
  private tail: Promise<unknown> = Promise.resolve();
  tx<T>(tenant: string, fn: (s: State) => T | Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      const s = structuredClone(this.states.get(tenant) ?? emptyState());
      const result = await fn(s);
      this.states.set(tenant, s);
      return structuredClone(result);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async tenants() {
    return [...this.states.keys()];
  }
  async close() {}
}
export class PostgresStore implements Store {
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  async tx<T>(tenant: string, fn: (s: State) => T | Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO harness_tenants (tenant_id,state) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [tenant, JSON.stringify(emptyState())],
      );
      const row = await c.query(
        "SELECT state FROM harness_tenants WHERE tenant_id=$1 FOR UPDATE",
        [tenant],
      );
      const s = row.rows[0].state as State;
      const result = await fn(s);
      await c.query(
        "UPDATE harness_tenants SET state=$2, revision=revision+1 WHERE tenant_id=$1",
        [tenant, JSON.stringify(s)],
      );
      await c.query("COMMIT");
      return structuredClone(result);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async tenants() {
    return (
      await this.pool.query("SELECT tenant_id FROM harness_tenants")
    ).rows.map((x) => x.tenant_id as string);
  }
  async close() {
    await this.pool.end();
  }
}
