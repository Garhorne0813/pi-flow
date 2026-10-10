import pg from "pg";
import { emptyState, type State } from "./domain.js";
import type { CapacityState } from "./adapters/sandbox-policy.js";
import { SCHEMA_VERSION, type WorkerHealth } from "./health.js";
export interface Store {
  ready(): Promise<void>;
  workerHeartbeat(health: WorkerHealth): Promise<void>;
  workerHealth(): Promise<WorkerHealth[]>;
  read<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  tx<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  tenants(): Promise<string[]>;
  capacityRead<T>(fn: (state: CapacityState) => T | Promise<T>): Promise<T>;
  capacityTx<T>(fn: (state: CapacityState) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class MemoryStore implements Store {
  private workers = new Map<string, WorkerHealth>();
  async ready() {}
  async workerHeartbeat(health: WorkerHealth) {
    this.workers.set(health.workerId, structuredClone(health));
  }
  async workerHealth() {
    return structuredClone([...this.workers.values()]);
  }
  private states = new Map<string, State>();
  private tail: Promise<unknown> = Promise.resolve();
  private capacity: CapacityState = { entries: {} };
  async capacityRead<T>(
    fn: (state: CapacityState) => T | Promise<T>,
  ): Promise<T> {
    await this.tail;
    return structuredClone(await fn(structuredClone(this.capacity)));
  }
  capacityTx<T>(fn: (state: CapacityState) => T | Promise<T>): Promise<T> {
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
  private healthPool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
    this.healthPool = new pg.Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 1000,
      query_timeout: 1000,
    });
  }
  async ready() {
    const result = await this.healthPool.query(
      "SELECT version FROM harness_schema WHERE id=1",
    );
    if (result.rows[0]?.version !== SCHEMA_VERSION)
      throw new Error("SCHEMA_MISMATCH");
    const tables = await this.healthPool.query(
      "SELECT to_regclass('harness_tenants') AS tenants, to_regclass('harness_sandbox_capacity') AS capacity, to_regclass('harness_worker_health') AS workers",
    );
    if (Object.values(tables.rows[0]).some((v) => v === null))
      throw new Error("SCHEMA_INCOMPLETE");
  }
  async workerHeartbeat(health: WorkerHealth) {
    await this.healthPool.query(
      "INSERT INTO harness_worker_health(worker_id,health,updated_at) VALUES($1,$2,now()) ON CONFLICT(worker_id) DO UPDATE SET health=excluded.health,updated_at=excluded.updated_at",
      [health.workerId, JSON.stringify(health)],
    );
  }
  async workerHealth() {
    const result = await this.healthPool.query(
      "SELECT health FROM harness_worker_health WHERE updated_at > now() - interval '1 day'",
    );
    return result.rows.map((row) => row.health as WorkerHealth);
  }
  async capacityRead<T>(
    fn: (state: CapacityState) => T | Promise<T>,
  ): Promise<T> {
    const row = await this.pool.query(
      "SELECT state FROM harness_sandbox_capacity WHERE id=1",
    );
    return structuredClone(await fn(row.rows[0]?.state ?? { entries: {} }));
  }
  async capacityTx<T>(
    fn: (state: CapacityState) => T | Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO harness_sandbox_capacity (id,state) VALUES (1,$1) ON CONFLICT DO NOTHING",
        [JSON.stringify({ entries: {} })],
      );
      const row = await c.query(
        "SELECT state FROM harness_sandbox_capacity WHERE id=1 FOR UPDATE",
      );
      const state = row.rows[0].state as CapacityState,
        result = await fn(state);
      await c.query("UPDATE harness_sandbox_capacity SET state=$1 WHERE id=1", [
        JSON.stringify(state),
      ]);
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
    await Promise.all([this.pool.end(), this.healthPool.end()]);
  }
}
