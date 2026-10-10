import pg from "pg";
import { emptyState, type State } from "./domain.js";
import { readCapacity, writeCapacity } from "./capacity-store.js";
import type {
  CapacityScope,
  CapacityState,
} from "./adapters/sandbox-policy.js";
export interface Store {
  read<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  tx<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  tenants(): Promise<string[]>;
  capacityRead<T>(
    fn: (state: CapacityState) => T | Promise<T>,
    scope?: CapacityScope,
  ): Promise<T>;
  capacityTx<T>(
    fn: (state: CapacityState) => T | Promise<T>,
    scope?: CapacityScope,
  ): Promise<T>;
  close(): Promise<void>;
}
export class MemoryStore implements Store {
  private states = new Map<string, State>();
  private tail: Promise<unknown> = Promise.resolve();
  private capacity: CapacityState = { entries: {} };
  async capacityRead<T>(
    fn: (state: CapacityState) => T | Promise<T>,
    scope?: CapacityScope,
  ): Promise<T> {
    await this.tail;
    return structuredClone(await fn(structuredClone(this.capacity)));
  }
  capacityTx<T>(
    fn: (state: CapacityState) => T | Promise<T>,
    scope?: CapacityScope,
  ): Promise<T> {
    const task = this.tail.then(async () => {
      const s = structuredClone(this.capacity),
        result = await fn(s);
      this.capacity = s;
      return structuredClone(result);
    });
    this.tail = task.catch(() => {});
    return task;
  }
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
  async read<T>(tenant: string, fn: (s: State) => T | Promise<T>): Promise<T> {
    await this.tail;
    const snapshot = structuredClone(this.states.get(tenant) ?? emptyState());
    return structuredClone(await fn(snapshot));
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
  async capacityRead<T>(
    fn: (state: CapacityState) => T | Promise<T>,
    scope?: CapacityScope,
  ): Promise<T> {
    return structuredClone(await fn(await readCapacity(this.pool, scope)));
  }
  async capacityTx<T>(
    fn: (state: CapacityState) => T | Promise<T>,
    scope?: CapacityScope,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Global quota admits reservations serially. A lock contains no JSON and
      // every transition uses it, so count+reserve cannot race a release/adoption.
      await c.query("SELECT pg_advisory_xact_lock(134697,13)");
      const before = await readCapacity(c, scope),
        state = structuredClone(before);
      const result = await fn(state);
      await writeCapacity(c, before, state, scope);
      await c.query("COMMIT");
      return structuredClone(result);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
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
  async read<T>(tenant: string, fn: (s: State) => T | Promise<T>): Promise<T> {
    const row = await this.pool.query(
      "SELECT state FROM harness_tenants WHERE tenant_id=$1",
      [tenant],
    );
    return structuredClone(await fn(row.rows[0]?.state ?? emptyState()));
  }
  async tenants() {
    return (
      await this.pool.query(
        "SELECT tenant_id FROM harness_tenants ORDER BY tenant_id",
      )
    ).rows.map((x) => x.tenant_id as string);
  }
  async close() {
    await this.pool.end();
  }
}
