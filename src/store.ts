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
import { emptyState, type State } from "./domain.js";
import type { CapacityState } from "./adapters/sandbox-policy.js";
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
          if (this.closed) {
            c.release(true);
            return;
          }
          await c.query("LISTEN harness_run_event");
          if (this.closed) {
            c.release(true);
            return;
          }
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
    // One SELECT authorizes and replays in the same MVCC snapshot without
    // multiple round trips per subscriber poll.
    const result = await this.pool.query(
      `
      WITH RECURSIVE chain AS (
        SELECT data FROM harness_runs WHERE tenant_id=$1 AND run_id=$2
        UNION
        SELECT parent.data FROM harness_runs parent JOIN chain child
          ON parent.run_id=child.data->>'parentRunId' WHERE parent.tenant_id=$1
      )
      SELECT t.state,
        COALESCE((SELECT jsonb_agg(data) FROM chain), '[]'::jsonb) AS runs,
        COALESCE((SELECT jsonb_agg(s.data - 'entries') FROM harness_sessions s
          WHERE s.tenant_id=$1 AND s.session_id IN (SELECT data->>'sessionId' FROM chain)), '[]'::jsonb) AS sessions,
        COALESCE((SELECT jsonb_agg(page.data ORDER BY page.event_id) FROM (
          SELECT data,event_id FROM harness_run_events WHERE tenant_id=$1
            AND run_id=$2 AND event_id>$3 ORDER BY event_id LIMIT $4
        ) page), '[]'::jsonb) AS events
      FROM harness_tenants t WHERE t.tenant_id=$1`,
      [tenant, runId, after, limit],
    );
    const row = result.rows[0];
    const s = {
      ...emptyState(),
      ...row?.state,
      runs: Object.fromEntries(
        (row?.runs ?? []).map((r: { id: string }) => [r.id, r]),
      ),
      sessions: Object.fromEntries(
        (row?.sessions ?? []).map((ses: { id: string }) => [ses.id, ses]),
      ),
      events: [],
    } as State;
    return { state: authorize(s), events: (row?.events ?? []) as Event[] };
  }
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
    await this.pool.end();
  }
}
