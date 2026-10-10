import pg from "pg";
import {
  loadState,
  saveState,
  saveRun,
  saveEvents,
  metadata,
} from "./run-store.js";
import { emptyState, type State } from "./domain.js";
import type { CapacityState } from "./adapters/sandbox-policy.js";
export interface Store {
  read<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  tx<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  runTx<T>(
    tenant: string,
    runId: string,
    fn: (state: State) => T | Promise<T>,
  ): Promise<T>;
  tenants(): Promise<string[]>;
  capacityRead<T>(fn: (state: CapacityState) => T | Promise<T>): Promise<T>;
  capacityTx<T>(fn: (state: CapacityState) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class MemoryStore implements Store {
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
  runTx<T>(
    tenant: string,
    runId: string,
    fn: (state: State) => T | Promise<T>,
  ): Promise<T> {
    return this.tx(tenant, fn);
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
      const before = await loadState(c, tenant, true),
        s = structuredClone(before);
      const result = await fn(s);
      await saveState(c, tenant, before, s);
      await c.query("COMMIT");
      return structuredClone(result);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async runTx<T>(
    tenant: string,
    runId: string,
    fn: (state: State) => T | Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const before = await loadState(c, tenant, false, runId),
        s = structuredClone(before);
      const result = await fn(s);
      if (
        JSON.stringify(metadata(before)) !==
          JSON.stringify(metadata({ ...s, sequence: before.sequence })) ||
        JSON.stringify(before.sessions) !== JSON.stringify(s.sessions)
      )
        throw new Error(
          "runTx may only change the target Run and append events",
        );
      if (Object.keys(s.runs).some((rid) => rid !== runId && JSON.stringify(s.runs[rid])!==JSON.stringify(before.runs[rid])))
        throw new Error("runTx scope violation");
      const r = s.runs[runId];
      if (r && JSON.stringify(r) !== JSON.stringify(before.runs[runId]))
        await saveRun(c, tenant, r);
      await saveEvents(c, tenant, before, s);
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
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await fn(await loadState(c, tenant));
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
      await this.pool.query(
        "SELECT tenant_id FROM harness_tenants ORDER BY tenant_id",
      )
    ).rows.map((x) => x.tenant_id as string);
  }
  async close() {
    await this.pool.end();
  }
}
