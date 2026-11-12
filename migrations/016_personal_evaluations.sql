-- Offline upgrade. Eval rows never reference production sessions, runs or volumes.
CREATE TABLE IF NOT EXISTS personal_eval_suites (
 user_id text NOT NULL REFERENCES personal_user_state(user_id) ON DELETE CASCADE,
 suite_id uuid NOT NULL, data jsonb NOT NULL, deleted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(user_id,suite_id)
);
CREATE TABLE IF NOT EXISTS personal_eval_suite_versions (
 user_id text NOT NULL, suite_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), data jsonb NOT NULL,
 PRIMARY KEY(user_id,suite_id,version),
 FOREIGN KEY(user_id,suite_id) REFERENCES personal_eval_suites(user_id,suite_id)
);
CREATE TABLE IF NOT EXISTS personal_eval_cases (
 user_id text NOT NULL, suite_id uuid NOT NULL, version integer NOT NULL, case_id text NOT NULL, position integer NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(user_id,suite_id,version,case_id), UNIQUE(user_id,suite_id,version,position),
 FOREIGN KEY(user_id,suite_id,version) REFERENCES personal_eval_suite_versions(user_id,suite_id,version)
);
CREATE TABLE IF NOT EXISTS personal_eval_jobs (
 user_id text NOT NULL, job_id uuid NOT NULL, suite_id uuid NOT NULL, suite_version integer NOT NULL,
 agent_id text NOT NULL, state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELLED')),
 request_digest text NOT NULL, idempotency_key text NOT NULL, data jsonb NOT NULL,
 cancel_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,job_id), UNIQUE(user_id,idempotency_key),
 FOREIGN KEY(user_id,suite_id,suite_version) REFERENCES personal_eval_suite_versions(user_id,suite_id,version)
);
CREATE INDEX IF NOT EXISTS personal_eval_jobs_history ON personal_eval_jobs(user_id,created_at DESC,job_id);
CREATE INDEX IF NOT EXISTS personal_eval_jobs_agent_history ON personal_eval_jobs(user_id,agent_id,created_at DESC,job_id);
CREATE TABLE IF NOT EXISTS personal_eval_case_runs (
 user_id text NOT NULL, case_run_id uuid NOT NULL, job_id uuid NOT NULL, case_id text NOT NULL, repeat_index integer NOT NULL CHECK(repeat_index>=0),
 state text NOT NULL CHECK(state IN ('QUEUED','RUNNING','GRADING','PASSED','FAILED_ASSERTION','EXECUTION_ERROR','GRADING_ERROR','CANCELLED')),
 lease_owner text, lease_generation uuid, lease_expires_at timestamptz,
 data jsonb NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,case_run_id), UNIQUE(user_id,job_id,case_id,repeat_index),
 FOREIGN KEY(user_id,job_id) REFERENCES personal_eval_jobs(user_id,job_id) ON DELETE CASCADE,
 CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)), CHECK((lease_owner IS NULL)=(lease_generation IS NULL))
);
CREATE INDEX IF NOT EXISTS personal_eval_case_runs_claim ON personal_eval_case_runs(state,created_at,case_run_id) WHERE state='QUEUED';
CREATE INDEX IF NOT EXISTS personal_eval_case_runs_job ON personal_eval_case_runs(user_id,job_id,created_at,case_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS personal_eval_user_running ON personal_eval_case_runs(user_id) WHERE state IN ('RUNNING','GRADING');
CREATE INDEX IF NOT EXISTS personal_eval_case_runs_expired ON personal_eval_case_runs(lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE TABLE IF NOT EXISTS personal_eval_scores (
 user_id text NOT NULL, case_run_id uuid NOT NULL, grader_id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(user_id,case_run_id,grader_id),
 FOREIGN KEY(user_id,case_run_id) REFERENCES personal_eval_case_runs(user_id,case_run_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_eval_event_counters (
 user_id text NOT NULL, job_id uuid NOT NULL, cursor bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,job_id), FOREIGN KEY(user_id,job_id) REFERENCES personal_eval_jobs(user_id,job_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS personal_eval_events (
 user_id text NOT NULL, job_id uuid NOT NULL, event_id bigint NOT NULL, data jsonb NOT NULL CHECK(pg_column_size(data)<=8192),
 PRIMARY KEY(user_id,job_id,event_id), FOREIGN KEY(user_id,job_id) REFERENCES personal_eval_jobs(user_id,job_id) ON DELETE CASCADE
);
-- Reserved for verified providers only. Unknown resources are retained for reconciliation.
CREATE TABLE IF NOT EXISTS personal_eval_sandbox_leases (
 user_id text NOT NULL, job_id uuid NOT NULL, resource_id text NOT NULL, generation uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('active','unknown','released')), data jsonb NOT NULL,
 PRIMARY KEY(user_id,job_id,resource_id), FOREIGN KEY(user_id,job_id) REFERENCES personal_eval_jobs(user_id,job_id)
);
UPDATE personal_schema SET version=14 WHERE id=1;
