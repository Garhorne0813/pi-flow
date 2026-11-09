import pg from "pg";
import { EventEmitter } from "node:events";
import { telemetry } from "./telemetry.js";
import {
  emptyState,
  type State,
  type Event,
  type RunState,
  type Audit,
} from "./domain.js";
import type { Store } from "./store.js";
import {
  loadState,
  saveState,
  saveRun,
  saveEvents,
  metadata,
  runSnapshotQuery,
  snapshotState,
  claimableRunsQuery,
} from "./personal-run-store.js";
import { resourceTransitions } from "./usage.js";
import { readCapacity, writeCapacity } from "./personal-capacity-store.js";
import type {
  CapacityScope,
  CapacityState,
} from "./adapters/sandbox-policy.js";
import { type WorkerHealth } from "./health.js";
const SCHEMA_VERSION = 6;
function candidateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid candidate limit");
}
export class PersonalPostgresStore implements Store {
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
    const result = await this.pool.query(runSnapshotQuery, [
      tenant,
      runId,
      after,
      limit,
      false,
      false,
    ]);
    return {
      state: authorize(snapshotState(result.rows[0])),
      events: (result.rows[0]?.events ?? []) as Event[],
    };
  }
  async appendAudit(tenant: string, entry: Audit) {
    // Atomic row update serializes with metadata transactions without loading
    // Runs, Sessions, Events or the existing audit array into the application.
    await this.pool.query(
      `INSERT INTO personal_user_state(user_id,state,revision) VALUES($1,$2,1)
       ON CONFLICT(user_id) DO UPDATE SET
       state=jsonb_set(personal_user_state.state,'{audit}',COALESCE(personal_user_state.state->'audit','[]'::jsonb)||$3::jsonb),
       revision=personal_user_state.revision+1`,
      [
        tenant,
        JSON.stringify({ ...metadata(emptyState()), audit: [entry] }),
        JSON.stringify([entry]),
      ],
    );
  }
  async listClaimableRuns(tenant: string, now: number, limit: number) {
    candidateLimit(limit);
    const result = await this.pool.query(claimableRunsQuery, [
      tenant,
      now,
      limit,
    ]);
    return result.rows.map((row) => row.run_id as string);
  }
  async readRun<T>(
    tenant: string,
    runId: string,
    fn: (state: State) => T | Promise<T>,
    includeEntries = false,
  ) {
    const result = await this.pool.query(runSnapshotQuery, [
      tenant,
      runId,
      0,
      0,
      includeEntries,
      true,
    ]);
    return structuredClone(await fn(snapshotState(result.rows[0])));
  }
  async readMetadata<T>(
    tenant: string,
    keys: (keyof State)[],
    fn: (state: State) => T | Promise<T>,
  ) {
    const result = await this.pool.query(
      `SELECT COALESCE(jsonb_object_agg(k,state->k) FILTER (WHERE state ? k), '{}'::jsonb) AS state
       FROM personal_user_state CROSS JOIN unnest($2::text[]) k WHERE user_id=$1`,
      [tenant, keys],
    );
    return structuredClone(
      await fn({ ...emptyState(), ...result.rows[0]?.state }),
    );
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
    for (const pool of [this.pool, this.healthPool]) {
      // pg emits errors for terminated idle sockets separately from query
      // rejections. Keep them observable without crashing the process.
      pool.on("error", (error) => telemetry.error("postgres_pool", error));
      pool.on("connect", (client) => {
        // Checked-out transaction clients can fail between queries. Subsequent
        // queries reject; the transaction path rolls back and discards them.
        client.on("error", () => {});
      });
    }
  }
  async ready() {
    const result = await this.healthPool.query(
      "SELECT version FROM personal_schema WHERE id=1",
    );
    if (result.rows[0]?.version !== SCHEMA_VERSION)
      throw new Error("SCHEMA_MISMATCH");
    const tables = await this.healthPool.query(
      "SELECT to_regclass('personal_agents') AS agents, to_regclass('personal_user_state') AS tenants, to_regclass('personal_sandbox_capacity') AS capacity, to_regclass('personal_sandbox_leases') AS leases, to_regclass('personal_worker_health') AS workers, to_regclass('personal_runs') AS runs, to_regclass('personal_sessions') AS sessions, to_regclass('personal_run_events') AS events, to_regclass('personal_event_sequences') AS sequences",
    );
    if (Object.values(tables.rows[0]).some((v) => v === null))
      throw new Error("SCHEMA_INCOMPLETE");
  }
  async workerHeartbeat(health: WorkerHealth) {
    await this.healthPool.query(
      "INSERT INTO personal_worker_health(worker_id,health,updated_at) VALUES($1,$2,now()) ON CONFLICT(worker_id) DO UPDATE SET health=excluded.health,updated_at=excluded.updated_at",
      [health.workerId, JSON.stringify(health)],
    );
  }
  async workerHealth() {
    const result = await this.healthPool.query(
      "SELECT health FROM personal_worker_health WHERE updated_at > now() - interval '1 day'",
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
      try {
        await c.query("ROLLBACK");
      } catch {
        // A lost connection already aborted the server transaction. Preserve
        // the original failure; pg discards its unqueryable client on release.
      }
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
        "INSERT INTO personal_user_state (user_id,state) VALUES ($1,$2) ON CONFLICT DO NOTHING",
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
      try {
        await c.query("ROLLBACK");
      } catch {
        // A lost connection already aborted the server transaction. Preserve
        // the original failure; pg discards its unqueryable client on release.
      }
      throw e;
    } finally {
      c.release();
    }
  }
  async txLight<T>(
    user: string,
    sessionId: string,
    fn: (s: State) => T | Promise<T>,
    key?: string,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const row = await c.query(
        "SELECT state FROM personal_user_state WHERE user_id=$1 FOR UPDATE",
        [user],
      );
      const state: State = {
        ...emptyState(),
        ...row.rows[0]?.state,
        runs: {},
        sessions: {},
        events: [],
      };
      const sessions = await c.query(
        "SELECT data FROM personal_sessions WHERE user_id=$1 AND session_id=$2 FOR UPDATE",
        [user, sessionId],
      );
      for (const row of sessions.rows) state.sessions[row.data.id] = row.data;
      const runs = await c.query(
        "SELECT data FROM personal_runs WHERE user_id=$1 AND session_id=$2 AND (state IN ('QUEUED','RUNNING','WAITING_INPUT') OR idempotency_key=$3) ORDER BY run_id FOR UPDATE",
        [user, sessionId, key ?? null],
      );
      for (const row of runs.rows) state.runs[row.data.id] = row.data;
      const before = structuredClone(state),
        result = await fn(state);
      if (
        Object.values(state.sessions).some((s) => s.id !== sessionId) ||
        Object.values(state.runs).some((r) => r.sessionId !== sessionId)
      )
        throw new Error("txLight scope violation");
      resourceTransitions(before, state);
      await saveState(c, user, before, state);
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
      try {
        await c.query("ROLLBACK");
      } catch {
        // A lost connection already aborted the server transaction. Preserve
        // the original failure; pg discards its unqueryable client on release.
      }
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
      try {
        await c.query("ROLLBACK");
      } catch {
        // A lost connection already aborted the server transaction. Preserve
        // the original failure; pg discards its unqueryable client on release.
      }
      throw e;
    } finally {
      c.release();
    }
  }
  async tenants() {
    return (
      await this.pool.query(
        "SELECT user_id FROM personal_user_state ORDER BY user_id",
      )
    ).rows.map((x) => x.user_id as string);
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
