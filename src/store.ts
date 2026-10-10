import pg from "pg";
import { EventEmitter } from "node:events";
import type { Event, RunState } from "./domain.js";
import {
  loadState,
  saveState,
  saveRun,
  saveEvents,
  metadata,
} from "./run-store.js";
import { resourceTransitions } from "./usage.js";
import { emptyState, type State } from "./domain.js";
import { readCapacity, writeCapacity } from "./capacity-store.js";
import type {
  CapacityScope,
  CapacityState,
} from "./adapters/sandbox-policy.js";
import { SCHEMA_VERSION, type WorkerHealth } from "./health.js";
export interface Store {
  eventPage(
    tenant: string,
    runId: string,
    after: number,
    limit: number,
    authorize: (s: State) => RunState,
  ): Promise<{ state: RunState; events: Event[] }>;
  waitForEvents(
    tenant: string,
    runId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  ready(): Promise<void>;
  workerHeartbeat(health: WorkerHealth): Promise<void>;
  workerHealth(): Promise<WorkerHealth[]>;
  read<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  tx<T>(tenant: string, fn: (state: State) => T | Promise<T>): Promise<T>;
  runTx<T>(
    tenant: string,
    runId: string,
    fn: (state: State) => T | Promise<T>,
  ): Promise<T>;
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
  async eventPage(
    tenant: string,
    runId: string,
    after: number,
    limit: number,
    authorize: (s: State) => RunState,
  ) {
    return this.read(tenant, (s) => ({
      state: authorize(s),
      events: s.events
        .filter((e) => e.runId === runId && e.eventId > after)
        .slice(0, limit),
    }));
  }
  async waitForEvents(
    _tenant: string,
    _runId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  }
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
      const before = structuredClone(s);
      const result = await fn(s);
      resourceTransitions(before, s);
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
  private notifications = new EventEmitter().setMaxListeners(0);
  private closed = false;
  private listener?: pg.PoolClient;
  private listening?: Promise<void>;
  private async listen() {
    if (this.closed) return;
    if (!this.listening)
      this.listening = (async () => {
        const c = await this.pool.connect();
        try {
          if (this.closed) { c.release(true); return; }
          await c.query("LISTEN harness_run_event");
          if (this.closed) { c.release(true); return; }
          this.listener = c;
          c.on("notification", (m) => {
            if (m.payload) this.notifications.emit(m.payload);
          });
          c.on("error", () => {
            this.listener = undefined;
            this.listening = undefined;
            this.notifications.emit("disconnected");
            c.release(true);
          });
        } catch (e) {
          c.release(true);
          throw e;
        }
      })().catch(() => {
        this.listening = undefined;
      });
    await this.listening;
  }
  async waitForEvents(
    tenant: string,
    runId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    const key = JSON.stringify([tenant, runId]);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.notifications.off(key, done);
        this.notifications.off("disconnected", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.notifications.once(key, done);
      this.notifications.once("disconnected", done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted || this.closed) done();
      else void this.listen();
    });
  }
  async eventPage(
    tenant: string,
    runId: string,
    after: number,
    limit: number,
    authorize: (s: State) => RunState,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const s = await loadState(c, tenant, false, runId, false),
        state = authorize(s);
      const result = await c.query(
        "SELECT data FROM harness_run_events WHERE tenant_id=$1 AND run_id=$2 AND event_id>$3 ORDER BY event_id LIMIT $4",
        [tenant, runId, after, limit],
      );
      await c.query("COMMIT");
      return { state, events: result.rows.map((row) => row.data as Event) };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
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
      const before = await loadState(c, tenant, true),
        s = structuredClone(before);
      const result = await fn(s);
      resourceTransitions(before, s);
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
      if (
        Object.keys(s.runs).some(
          (rid) =>
            rid !== runId &&
            JSON.stringify(s.runs[rid]) !== JSON.stringify(before.runs[rid]),
        )
      )
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
    this.closed = true;
    this.notifications.emit("disconnected");
    await this.listening;
    if (this.listener) {
      this.listener.release(true);
      this.listener = undefined;
    }
    await Promise.all([this.pool.end(), this.healthPool.end()]);
  }
}
