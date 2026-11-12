import pg from "pg";
import {
  runWorkQuery,
  sandboxMaintenanceQuery,
  scheduleFireHistoryQuery,
} from "./personal-work-queries.js";
import {
  executionState,
  saveExecutionMetadata,
  type ExecutionScope,
} from "./personal-execution-store.js";
import {
  appendRecordAudit,
  loadRecords,
  saveRecords,
} from "./personal-records.js";
import { personalConnection } from "../execution/personal-context.js";
import { EventEmitter } from "node:events";
import { telemetry } from "../observability/telemetry.js";
import {
  emptyState,
  Fault,
  type State,
  type Session,
  type Event,
  type RunState,
  type Audit,
} from "../domain/model.js";
import type { Store } from "./store.js";
import {
  loadState,
  saveState,
  saveRun,
  saveEvents,
  metadata,
  runSnapshotQuery,
  authorizationSnapshotQuery,
  snapshotState,
  claimableRunsQuery,
  scheduleWorkQuery,
  fireKey,
} from "./personal-run-store.js";
import { resourceTransitions } from "../domain/usage.js";
import { readCapacity, writeCapacity } from "./personal-capacity-store.js";
import type { CapacityScope, CapacityState } from "../sandbox/policy.js";
import { type WorkerHealth } from "../observability/health.js";
const SCHEMA_VERSION = 14;
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
  async watchEvents(user: string, runId: string) {
    await this.listen();
    const key = JSON.stringify([user, runId]);
    let pending = false,
      closed = false;
    let wake: (() => void) | undefined;
    const changed = () => {
      pending = true;
      wake?.();
    };
    this.notifications.on(key, changed);
    this.notifications.on("disconnected", changed);
    return {
      wait: async (ms: number, signal?: AbortSignal) => {
        if (!closed && !signal?.aborted && !this.listener) await this.listen();
        if (pending || closed || signal?.aborted) {
          pending = false;
          return;
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            wake = undefined;
            pending = false;
            resolve();
          };
          const timer = setTimeout(done, ms);
          wake = done;
          signal?.addEventListener("abort", done, { once: true });
          if (pending || closed || signal?.aborted) done();
        });
        // Re-establish LISTEN before the caller's next catch-up query; the
        // persistent pending flag covers notifications between query and wait.
        if (!closed && !signal?.aborted && !this.listener) await this.listen();
      },
      close: () => {
        closed = true;
        wake?.();
        this.notifications.off(key, changed);
        this.notifications.off("disconnected", changed);
      },
    };
  }
  async appendRunEvents(
    user: string,
    rid: string,
    owner: string,
    events: { type: string; data: unknown }[],
  ) {
    if (!events.length) return;
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const row = (
        await c.query(
          "SELECT session_id FROM personal_runs WHERE user_id=$1 AND run_id=$2 AND lease_owner=$3 AND lease_expires>=$4 AND state='RUNNING' AND NOT COALESCE((data->>'cancelRequested')::boolean,false) FOR SHARE",
          [user, rid, owner, Date.now()],
        )
      ).rows[0];
      if (!row) throw new Fault(409, "LEASE_LOST");
      const before = emptyState(),
        after = emptyState();
      after.events = events.map((e) => ({
        seq: 0,
        eventId: 0,
        runId: rid,
        sessionId: row.session_id,
        type: e.type,
        data: e.data,
        timestamp: new Date().toISOString(),
      }));
      await saveEvents(c, user, before, after);
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
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
    await appendRecordAudit(this.pool, tenant, entry);
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
    const result = await this.pool.query(authorizationSnapshotQuery, [
      tenant,
      runId,
      0,
      0,
      includeEntries,
      true,
    ]);
    return structuredClone(await fn(snapshotState(result.rows[0])));
  }
  async listScheduleFires(
    user: string,
    scheduleId: string,
    owner: string,
    limit: number,
    before?: { scheduledFor: number; id: string },
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid page limit");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const task = (
        await c.query(
          "SELECT data FROM personal_scheduled_tasks WHERE user_id=$1 AND schedule_id=$2",
          [user, scheduleId],
        )
      ).rows[0]?.data;
      if (!task || task.userId !== owner)
        throw new Fault(404, "SCHEDULE_NOT_FOUND");
      const result = await c.query(scheduleFireHistoryQuery, [
        user,
        scheduleId,
        before?.scheduledFor ?? Number.MAX_SAFE_INTEGER,
        before?.id ?? "\uffff",
        limit,
      ]);
      await c.query("COMMIT");
      return result.rows.map(
        (r) => r.data,
      ) as import("../schedules/service.js").Fire[];
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }

  async listSessions(
    tenant: string,
    userId: string,
    offset: number,
    limit: number,
  ): Promise<Omit<Session, "entries">[]> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid pagination");
    const result = await this.pool.query(
      `SELECT data-'entries' AS data FROM personal_sessions
       WHERE user_id=$1 AND data->>'userId'=$2 AND COALESCE(data->>'deletedAt','')=''
       ORDER BY data->>'createdAt' DESC,session_id DESC LIMIT $3 OFFSET $4`,
      [tenant, userId, limit, offset],
    );
    return result.rows.map(({ data }) => data);
  }
  async readMetadata<T>(
    tenant: string,
    keys: (keyof State)[],
    fn: (state: State) => T | Promise<T>,
  ) {
    const result = await this.pool.query(
      `SELECT COALESCE((SELECT jsonb_object_agg(k,state->k) FILTER (WHERE state ? k)
        FROM personal_user_state CROSS JOIN unnest($2::text[]) k WHERE user_id=$1), '{}'::jsonb)
       || CASE WHEN 'schedules'=ANY($2::text[]) THEN jsonb_build_object('schedules',
          COALESCE((SELECT jsonb_object_agg(schedule_id,data) FROM personal_scheduled_tasks WHERE user_id=$1),'{}'::jsonb)) ELSE '{}'::jsonb END
       || CASE WHEN 'scheduleFires'=ANY($2::text[]) THEN jsonb_build_object('scheduleFires',
          COALESCE((SELECT jsonb_object_agg(schedule_id||':'||trigger||':'||scheduled_for,data)
            FROM personal_schedule_fires WHERE user_id=$1),'{}'::jsonb)) ELSE '{}'::jsonb END AS state`,
      [tenant, keys],
    );
    const state = { ...emptyState(), ...result.rows[0]?.state };
    await loadRecords(this.pool, tenant, state, keys);
    return structuredClone(await fn(state));
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
      "SELECT to_regclass('personal_agents') AS agents, to_regclass('personal_user_state') AS tenants, to_regclass('personal_sandbox_capacity') AS capacity, to_regclass('personal_sandbox_leases') AS leases, to_regclass('personal_worker_health') AS workers, to_regclass('personal_runs') AS runs, to_regclass('personal_sessions') AS sessions, to_regclass('personal_run_events') AS events, to_regclass('personal_event_sequences') AS sequences, to_regclass('personal_scheduled_tasks') AS schedules, to_regclass('personal_schedule_fires') AS fires, to_regclass('personal_audit') AS audit, to_regclass('personal_usage_requests') AS usage, to_regclass('personal_resource_transitions') AS resources, to_regclass('personal_workspace_runtime') AS runtime, to_regclass('personal_maintenance') AS maintenance, to_regclass('personal_run_event_counters') AS event_counters, to_regclass('personal_run_work') AS work, to_regclass('personal_eval_suites') AS eval_suites, to_regclass('personal_eval_suite_versions') AS eval_versions, to_regclass('personal_eval_cases') AS eval_cases, to_regclass('personal_eval_jobs') AS eval_jobs, to_regclass('personal_eval_case_runs') AS eval_runs, to_regclass('personal_eval_scores') AS eval_scores, to_regclass('personal_eval_events') AS eval_events, to_regclass('personal_eval_event_counters') AS eval_counters, to_regclass('personal_eval_sandbox_leases') AS eval_leases",
    );
    if (Object.values(tables.rows[0]).some((v) => v === null))
      throw new Error("SCHEMA_INCOMPLETE");
    const indexes = await this.healthPool.query(`SELECT
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_runs_running')
        AND indrelid=to_regclass('personal_runs') AND indisvalid AND indisready) AS running,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_scheduled_tasks_due')
        AND indrelid=to_regclass('personal_scheduled_tasks') AND indisvalid AND indisready) AS due,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_schedule_fires_pending')
        AND indrelid=to_regclass('personal_schedule_fires') AND indisvalid AND indisready) AS pending,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_sessions_list')
        AND indrelid=to_regclass('personal_sessions') AND indisvalid AND indisready) AS session_list,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_runs_task') AND indrelid=to_regclass('personal_runs') AND indisvalid AND indisready) AS task,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_runs_global_queued') AND indrelid=to_regclass('personal_runs') AND indisvalid AND indisready) AS queue,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_usage_period') AND indrelid=to_regclass('personal_usage_requests') AND indisvalid AND indisready) AS usage_period,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_usage_run') AND indrelid=to_regclass('personal_usage_requests') AND indisvalid AND indisready) AS usage_run,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_resources_user') AND indrelid=to_regclass('personal_resource_transitions') AND indisvalid AND indisready) AS resources_user,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_workspace_idle') AND indrelid=to_regclass('personal_workspace_runtime') AND indisvalid AND indisready) AS idle,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_run_work_queued') AND indrelid=to_regclass('personal_run_work') AND indisvalid AND indisready) AS work_queued,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_run_work_expired') AND indrelid=to_regclass('personal_run_work') AND indisvalid AND indisready) AS work_expired,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_workspace_rotation') AND indrelid=to_regclass('personal_workspace_runtime') AND indisvalid AND indisready) AS rotation,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_schedule_fires_history') AND indrelid=to_regclass('personal_schedule_fires') AND indisvalid AND indisready) AS fire_history,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_run_work_dispatchable') AND indrelid=to_regclass('personal_run_work') AND indisvalid AND indisready) AS dispatchable,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_audit_page') AND indrelid=to_regclass('personal_audit') AND indisvalid AND indisready) AS audit_page,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_runs_task_identity') AND indrelid=to_regclass('personal_runs') AND indisvalid AND indisready) AS task_identity,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_tool_failures') AND indrelid=to_regclass('personal_run_events') AND indisvalid AND indisready) AS tool_failures,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_eval_case_runs_claim') AND indrelid=to_regclass('personal_eval_case_runs') AND indisvalid AND indisready) AS eval_claim,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_eval_case_runs_expired') AND indrelid=to_regclass('personal_eval_case_runs') AND indisvalid AND indisready) AS eval_expired,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_eval_jobs_history') AND indrelid=to_regclass('personal_eval_jobs') AND indisvalid AND indisready) AS eval_history,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_eval_jobs_agent_history') AND indrelid=to_regclass('personal_eval_jobs') AND indisvalid AND indisready) AS eval_agent_history,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_eval_case_runs_job') AND indrelid=to_regclass('personal_eval_case_runs') AND indisvalid AND indisready) AS eval_job_cases,
      EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('personal_eval_user_running') AND indrelid=to_regclass('personal_eval_case_runs') AND indisvalid AND indisready) AS eval_user_running`);
    if (Object.values(indexes.rows[0]).some((v) => v !== true))
      throw new Error("SCHEMA_INDEXES_INCOMPLETE");
    const triggers = await this.healthPool
      .query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid=to_regclass('personal_runs') AND NOT tgisinternal AND tgenabled IN ('O','A') AND (tgname,tgfoid) IN (
      ('personal_runs_work_insert',to_regprocedure('personal_run_work_insert()')),('personal_runs_work_update',to_regprocedure('personal_run_work_update()')),('personal_runs_work_delete',to_regprocedure('personal_run_work_delete()')))`);
    if (triggers.rows[0].n !== 3) throw new Error("SCHEMA_TRIGGERS_INCOMPLETE");
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
      const result = await personalConnection.run(
        { pool: this.pool, client: c },
        () => fn(state),
      );
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
  async adminStats(user: string): Promise<import("./store.js").AdminStats> {
    const result = await this.pool.query(
      `WITH summaries AS (
      SELECT state,count(*) AS n,
      sum(CASE WHEN NULLIF(data->>'startedAt','') IS NOT NULL AND NULLIF(data->>'endedAt','') IS NOT NULL
        THEN extract(epoch FROM ((data->>'endedAt')::timestamptz-(data->>'startedAt')::timestamptz))*1000 END) AS duration,
      count(*) FILTER (WHERE NULLIF(data->>'startedAt','') IS NOT NULL AND NULLIF(data->>'endedAt','') IS NOT NULL) AS samples
      FROM personal_runs WHERE user_id=$1 GROUP BY state
    ) SELECT COALESCE(jsonb_object_agg(state,n),'{}'::jsonb) AS runs,
      COALESCE(sum(duration)/NULLIF(sum(samples),0),0)::float8 AS "averageRunDurationMs",
      (SELECT count(*)::int FROM personal_user_state u CROSS JOIN LATERAL jsonb_each(COALESCE(u.state->'interactions','{}'::jsonb)) i
       JOIN personal_runs r ON r.user_id=u.user_id AND r.run_id=i.value->>'runId'
       WHERE u.user_id=$1 AND NOT COALESCE((i.value->>'resolved')::boolean,false) AND r.state='WAITING_INPUT') AS "pendingInteractions",
      (SELECT count(*)::int FROM personal_run_events WHERE user_id=$1 AND data->>'type'='tool.failed') AS "toolFailures"
      FROM summaries`,
      [user],
    );
    return result.rows[0];
  }
  async cancelTaskTx<T>(
    user: string,
    runId: string,
    fn: (s: State) => T | Promise<T>,
  ) {
    return this.executionTx(user, runId, fn);
  }
  async interactionTx<T>(
    user: string,
    interactionId: string,
    fn: (s: State) => T | Promise<T>,
  ) {
    return this.executionTx(user, "", fn, { interactionId, admission: true });
  }
  async listAudit(
    user: string,
    offset: number,
    limit: number,
    after?: { timestamp: string; id: string },
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 101 ||
      (after && offset !== 0)
    )
      throw new Error("Invalid audit pagination");
    const result = await this.pool.query(
      `SELECT data FROM personal_audit WHERE user_id=$1${after ? " AND (data->>'timestamp',id)>($4::text,$5::text)" : ""} ORDER BY data->>'timestamp',id LIMIT $2 OFFSET $3`,
      after
        ? [user, limit, offset, after.timestamp, after.id]
        : [user, limit, offset],
    );
    return result.rows.map((r) => r.data) as State["audit"];
  }
  async executionTx<T>(
    user: string,
    runId: string,
    fn: (s: State) => T | Promise<T>,
    scope: ExecutionScope = {},
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const before = await executionState(c, user, runId, scope),
        s = structuredClone(before);
      const result = await personalConnection.run(
        { pool: this.pool, client: c },
        () => fn(s),
      );
      if (
        JSON.stringify(metadata(before)) !==
        JSON.stringify(
          metadata({
            ...s,
            workspaces: before.workspaces,
            todos: before.todos,
            interactions: before.interactions,
            sequence: before.sequence,
          }),
        )
      )
        throw new Error("executionTx metadata scope violation");
      for (const [sid, session] of Object.entries(s.sessions))
        if (
          before.sessions[sid] &&
          JSON.stringify(session) !== JSON.stringify(before.sessions[sid]) &&
          session.entries === undefined
        )
          throw new Error(
            "executionTx Session writes require an explicit checkpoint",
          );
      await saveState(c, user, before, s, true);
      await saveExecutionMetadata(c, user, before, s);
      await c.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async listRunWork(now: number, limit: number, afterUser = "") {
    candidateLimit(limit);
    const result = await this.pool.query(runWorkQuery, [now, afterUser, limit]);
    return result.rows as { user: string; runId: string }[];
  }
  async renewRunLease(user: string, runId: string, owner: string, now: number) {
    const result = await this.pool.query(
      `UPDATE personal_runs SET lease_expires=$4::bigint+30000,data=jsonb_set(data,'{lease,expires}',to_jsonb($4::bigint+30000))
      WHERE user_id=$1 AND run_id=$2 AND lease_owner=$3 AND lease_expires>=$4 AND state IN ('RUNNING','WAITING_INPUT') AND NOT COALESCE((data->>'cancelRequested')::boolean,false)`,
      [user, runId, owner, now],
    );
    return result.rowCount === 1;
  }
  async readUsage<T>(
    user: string,
    runId: string | undefined,
    fn: (s: State) => T | Promise<T>,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = runId
        ? snapshotState(
            (
              await c.query(authorizationSnapshotQuery, [
                user,
                runId,
                0,
                0,
                false,
                true,
              ])
            ).rows[0],
          )
        : {
            ...emptyState(),
            ...(
              await c.query(
                "SELECT jsonb_build_object('workspaces',state->'workspaces') AS state FROM personal_user_state WHERE user_id=$1",
                [user],
              )
            ).rows[0]?.state,
          };
      await loadRecords(c, user, state, ["usage"], runId);
      const result = await fn(state);
      await c.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async readSession<T>(
    user: string,
    sid: string,
    fn: (s: State) => T | Promise<T>,
  ) {
    const result = await this.pool.query(
      `SELECT p.data,jsonb_build_object('workspaces',jsonb_build_object(p.workspace_id,t.state->'workspaces'->p.workspace_id),'todos',jsonb_build_object(p.session_id,t.state->'todos'->p.session_id)) AS state
      FROM personal_sessions p JOIN personal_user_state t USING(user_id) WHERE p.user_id=$1 AND p.session_id=$2`,
      [user, sid],
    );
    const row = result.rows[0],
      state = { ...emptyState(), ...row?.state };
    if (row) state.sessions = { [sid]: row.data };
    return structuredClone(await fn(state));
  }
  async adoptLegacyCapacity() {
    /* migration 011 adopts legacy active bindings */
  }
  async listSandboxMaintenance(
    now: number,
    pauseMs: number,
    releaseMs: number,
    intervalMs: number,
  ) {
    const lease = await this.pool.query(
      "INSERT INTO personal_maintenance(name,expires) VALUES('sandbox',$1::bigint+$2::bigint) ON CONFLICT(name) DO UPDATE SET expires=excluded.expires WHERE personal_maintenance.expires<=$1 RETURNING name",
      [now, intervalMs],
    );
    if (!lease.rowCount) return [];
    const result = await this.pool.query(sandboxMaintenanceQuery, [
      now,
      pauseMs,
      releaseMs,
    ]);
    return result.rows as {
      user: string;
      workspace: State["workspaces"][string];
    }[];
  }
  async sessionTx<T>(
    user: string,
    sessionId: string | undefined,
    fn: (s: State) => T | Promise<T>,
    options: { entries?: boolean } = {},
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const meta = await c.query(
        "SELECT state->'workspaces' AS workspaces FROM personal_user_state WHERE user_id=$1 FOR NO KEY UPDATE",
        [user],
      );
      const state = {
        ...emptyState(),
        workspaces: meta.rows[0]?.workspaces ?? {},
      };
      if (sessionId) {
        const sessions = await c.query(
          "SELECT " +
            (options.entries ? "data" : "data-'entries' AS data") +
            " FROM personal_sessions WHERE user_id=$1 AND session_id=$2 FOR UPDATE",
          [user, sessionId],
        );
        if (sessions.rows[0]) state.sessions[sessionId] = sessions.rows[0].data;
        const busy = await c.query(
          "SELECT run_id,session_id,state FROM personal_runs WHERE user_id=$1 AND session_id=$2 AND state IN ('QUEUED','RUNNING','WAITING_INPUT') LIMIT 1",
          [user, sessionId],
        );
        for (const r of busy.rows)
          state.runs[r.run_id] = {
            id: r.run_id,
            sessionId: r.session_id,
            state: r.state,
          } as State["runs"][string];
      }
      const before = structuredClone(state);
      const result = await personalConnection.run(
        { pool: this.pool, client: c },
        () => fn(state),
      );
      if (
        JSON.stringify(metadata(before)) !== JSON.stringify(metadata(state)) ||
        JSON.stringify(before.runs) !== JSON.stringify(state.runs) ||
        JSON.stringify(before.events) !== JSON.stringify(state.events) ||
        JSON.stringify(before.usage) !== JSON.stringify(state.usage) ||
        JSON.stringify(before.schedules) !== JSON.stringify(state.schedules) ||
        JSON.stringify(before.scheduleFires) !==
          JSON.stringify(state.scheduleFires)
      )
        throw new Error("sessionTx scope violation");
      if (sessionId && before.sessions[sessionId] && !state.sessions[sessionId])
        throw new Error("sessionTx cannot remove its target");
      for (const [sid, s] of Object.entries(state.sessions)) {
        if (JSON.stringify(before.sessions[sid]) === JSON.stringify(s))
          continue;
        if (sid === sessionId && before.sessions[sid]) {
          await c.query(
            "UPDATE personal_sessions SET data=CASE WHEN $3::jsonb ? 'entries' THEN $3::jsonb ELSE $3::jsonb||jsonb_build_object('entries',data->'entries') END WHERE user_id=$1 AND session_id=$2",
            [user, sid, JSON.stringify(s)],
          );
        } else {
          if (s.userId !== user)
            throw new Error("sessionTx owner scope violation");
          await c.query(
            "INSERT INTO personal_sessions(user_id,session_id,workspace_id,data) VALUES($1,$2,$3,$4)",
            [user, sid, s.workspaceId, JSON.stringify(s)],
          );
        }
      }
      await saveRecords(c, user, before, state);
      await c.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async workspaceTx<T>(
    tenant: string,
    fn: (s: State) => T | Promise<T>,
  ): Promise<T> {
    return this.transact(tenant, fn, true);
  }
  async tx<T>(tenant: string, fn: (s: State) => T | Promise<T>): Promise<T> {
    return this.transact(tenant, fn, false);
  }
  private async transact<T>(
    tenant: string,
    fn: (s: State) => T | Promise<T>,
    workspaceOnly: boolean,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO personal_user_state (user_id,state) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [tenant, JSON.stringify(metadata(emptyState()))],
      );
      const before = await loadState(c, tenant, true, undefined, true, {
          workspaceOnly,
        }),
        s = structuredClone(before);
      const result = await personalConnection.run(
        { pool: this.pool, client: c },
        () => fn(s),
      );
      resourceTransitions(before, s);
      await saveState(c, tenant, before, s, workspaceOnly);
      if (
        workspaceOnly &&
        JSON.stringify(before.workspaces) !== JSON.stringify(s.workspaces)
      )
        await c.query(
          "UPDATE personal_user_state SET state=jsonb_set(state,'{workspaces}',$2::jsonb),revision=revision+1 WHERE user_id=$1",
          [tenant, JSON.stringify(s.workspaces)],
        );
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
        "SELECT state FROM personal_user_state WHERE user_id=$1 FOR NO KEY UPDATE",
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
        result = await personalConnection.run(
          { pool: this.pool, client: c },
          () => fn(state),
        );
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
    return this.targetedRunTx(tenant, runId, fn, false);
  }
  async claimRun<T>(
    tenant: string,
    runId: string,
    fn: (state: State) => T | Promise<T>,
  ): Promise<T> {
    return this.targetedRunTx(tenant, runId, fn, true);
  }
  private async targetedRunTx<T>(
    tenant: string,
    runId: string,
    fn: (state: State) => T | Promise<T>,
    claim: boolean,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const before = await loadState(c, tenant, claim, runId, true, { claim });
      if (claim) {
        // The user metadata lock serializes admission with every personal Run
        // writer. Only one indexed active row is needed to reject contention.
        const active = await c.query(
          "SELECT data FROM personal_runs WHERE user_id=$1 AND state='RUNNING' AND run_id<>$2 LIMIT 1",
          [tenant, runId],
        );
        for (const { data } of active.rows) before.runs[data.id] = data;
      }
      const s = structuredClone(before);
      const result = await personalConnection.run(
        { pool: this.pool, client: c },
        () => fn(s),
      );
      if (
        JSON.stringify(metadata(before)) !==
          JSON.stringify(metadata({ ...s, sequence: before.sequence })) ||
        JSON.stringify(before.sessions) !== JSON.stringify(s.sessions) ||
        JSON.stringify(before.audit) !== JSON.stringify(s.audit) ||
        JSON.stringify(before.usage) !== JSON.stringify(s.usage)
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
      if (r) {
        if (before.runs[runId]?.eventSeq === undefined) delete r.eventSeq;
        else r.eventSeq = before.runs[runId]!.eventSeq;
      }
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
  async listScheduleWork(now: number, limit: number) {
    candidateLimit(limit);
    const r = await this.pool.query(scheduleWorkQuery, [now, limit]);
    return r.rows.map((row) => ({
      user: row.user_id as string,
      scheduleId: row.schedule_id as string,
    }));
  }
  async scheduleTx<T>(
    tenant: string,
    scheduleId: string,
    fn: (state: State) => T | Promise<T>,
    options: { manualFor?: number } = {},
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const meta = await c.query(
        "SELECT state->'workspaces' AS workspaces FROM personal_user_state WHERE user_id=$1 FOR UPDATE",
        [tenant],
      );
      const s = {
        ...emptyState(),
        workspaces: meta.rows[0]?.workspaces ?? {},
        schedules: {},
        scheduleFires: {},
      } as State;
      const tasks = await c.query(
        "SELECT data FROM personal_scheduled_tasks WHERE user_id=$1 AND schedule_id=$2 FOR UPDATE",
        [tenant, scheduleId],
      );
      const task = tasks.rows[0]?.data as
        | import("../schedules/service.js").ScheduledTask
        | undefined;
      if (task) s.schedules![task.id] = task;
      if (task) {
        const existing = await c.query(
          "SELECT data FROM personal_schedule_fires WHERE user_id=$1 AND schedule_id=$2 AND ((trigger='cron' AND scheduled_for=$3) OR (trigger='manual' AND scheduled_for=$4::bigint))",
          [tenant, scheduleId, task.nextFireAt, options.manualFor ?? null],
        );
        for (const { data } of existing.rows)
          s.scheduleFires![fireKey(data)] = data;
      }
      const fires = await c.query(
        `SELECT f.data,r.data AS run FROM personal_schedule_fires f
        JOIN personal_runs r ON r.user_id=f.user_id AND r.run_id=f.data->>'runId'
        WHERE f.user_id=$1 AND f.schedule_id=$2 AND f.data->>'state'='submitted'
        AND r.state IN ('COMPLETED','FAILED','CANCELLED') ORDER BY f.scheduled_for,f.id LIMIT 64 FOR UPDATE OF f`,
        [tenant, scheduleId],
      );
      for (const row of fires.rows) {
        s.scheduleFires![fireKey(row.data)] = row.data;
        s.runs[row.run.id] = row.run;
      }
      if (task?.sessionId) {
        const sessions = await c.query(
          "SELECT data - 'entries' AS data FROM personal_sessions WHERE user_id=$1 AND session_id=$2",
          [tenant, task.sessionId],
        );
        for (const { data } of sessions.rows) s.sessions[data.id] = data;
        const active = await c.query(
          "SELECT data FROM personal_runs WHERE user_id=$1 AND session_id=$2 AND state IN ('QUEUED','RUNNING','WAITING_INPUT')",
          [tenant, task.sessionId],
        );
        for (const { data } of active.rows) s.runs[data.id] = data;
      }
      const sequence = await c.query(
        "SELECT cursor FROM personal_event_sequences WHERE user_id=$1",
        [tenant],
      );
      s.sequence = Number(sequence.rows[0]?.cursor ?? 0);
      const before = structuredClone(s);
      const result = await personalConnection.run(
        { pool: this.pool, client: c },
        () => fn(s),
      );
      if (
        JSON.stringify(metadata(before)) !==
          JSON.stringify(
            metadata({ ...s, audit: before.audit, sequence: before.sequence }),
          ) ||
        Object.keys(s.schedules ?? {}).some((id) => id !== scheduleId)
      )
        throw new Error("scheduleTx scope violation");
      await saveState(c, tenant, before, s, true);
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
      const result = await personalConnection.run(
        { pool: this.pool, client: c },
        async () => fn(await loadState(c, tenant)),
      );
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
