-- Fresh personal schema; legacy shared workspace ownership is never inferred.
CREATE TABLE IF NOT EXISTS personal_users(id text PRIMARY KEY CHECK(id::uuid IS NOT NULL),issuer text NOT NULL,subject text NOT NULL,enabled boolean NOT NULL DEFAULT true,UNIQUE(issuer,subject));
CREATE TABLE IF NOT EXISTS platform_config(scope text PRIMARY KEY,document jsonb NOT NULL,revision bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS personal_agent_versions(id uuid PRIMARY KEY,agent_id text NOT NULL,digest text NOT NULL,config jsonb NOT NULL,published_at timestamptz NOT NULL,enabled boolean NOT NULL);
CREATE TABLE IF NOT EXISTS personal_agent_definitions(id text PRIMARY KEY,key text UNIQUE NOT NULL,active_version_id uuid NOT NULL REFERENCES personal_agent_versions(id),enabled boolean NOT NULL);
CREATE TABLE IF NOT EXISTS personal_user_state(user_id text PRIMARY KEY REFERENCES personal_users(id) ON DELETE CASCADE,state jsonb NOT NULL,revision bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS personal_schema(id integer PRIMARY KEY CHECK(id=1),version integer NOT NULL);
INSERT INTO personal_schema VALUES(1,5) ON CONFLICT(id) DO UPDATE SET version=5;
CREATE TABLE IF NOT EXISTS personal_worker_health(worker_id text PRIMARY KEY,health jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS personal_sandbox_capacity(id integer PRIMARY KEY CHECK(id=1),state jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS personal_sandbox_leases(tenant_id text NOT NULL REFERENCES personal_user_state(user_id) ON DELETE CASCADE,workspace_id text NOT NULL,user_id text NOT NULL,state text NOT NULL CHECK(state IN ('reserved','active','paused','unknown','released')),sandbox_id text,operation text,updated_at bigint NOT NULL,PRIMARY KEY(tenant_id,workspace_id));
CREATE INDEX IF NOT EXISTS personal_sandbox_leases_charged ON personal_sandbox_leases(state) WHERE state IN ('reserved','active','unknown');
-- Offline migration: old JSONB writers must be stopped before cutover.
CREATE TABLE IF NOT EXISTS personal_sessions (
 user_id text NOT NULL REFERENCES personal_user_state(user_id) ON DELETE CASCADE,
 session_id text NOT NULL, workspace_id text NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(user_id,session_id)
);
CREATE TABLE IF NOT EXISTS personal_runs (
 user_id text NOT NULL, run_id text NOT NULL, session_id text NOT NULL,
 actor_id text NOT NULL, idempotency_key text, state text NOT NULL,
 lease_owner text, lease_expires bigint, created_at timestamptz NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(user_id,run_id),
 FOREIGN KEY(user_id,session_id) REFERENCES personal_sessions(user_id,session_id) ON DELETE CASCADE,
 CHECK(state IN ('QUEUED','RUNNING','WAITING_INPUT','COMPLETED','FAILED','CANCELLED')),
 CHECK((lease_owner IS NULL)=(lease_expires IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_runs_idempotency ON personal_runs(user_id,session_id,actor_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS personal_runs_session_busy ON personal_runs(user_id,session_id) WHERE state IN ('QUEUED','RUNNING','WAITING_INPUT');
CREATE INDEX IF NOT EXISTS personal_runs_claim ON personal_runs(user_id,state,created_at) WHERE state='QUEUED';
CREATE INDEX IF NOT EXISTS personal_runs_expired ON personal_runs(lease_expires) WHERE lease_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS personal_runs_tenant_expired ON personal_runs(user_id,lease_expires,run_id) WHERE lease_owner IS NOT NULL;
CREATE TABLE IF NOT EXISTS personal_run_events (
 user_id text NOT NULL, run_id text NOT NULL,event_id bigint NOT NULL,
 data jsonb NOT NULL,
 PRIMARY KEY(user_id,event_id),
 FOREIGN KEY(user_id,run_id) REFERENCES personal_runs(user_id,run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS personal_run_events_replay ON personal_run_events(user_id,run_id,event_id);
CREATE TABLE IF NOT EXISTS personal_event_sequences (
 user_id text PRIMARY KEY REFERENCES personal_user_state(user_id) ON DELETE CASCADE,
 cursor bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_secrets(ref text PRIMARY KEY,sealed text NOT NULL);
CREATE TABLE IF NOT EXISTS platform_config_publications(revision bigint PRIMARY KEY,digest text NOT NULL,published_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS personal_skills(id text PRIMARY KEY,active_digest text,enabled boolean NOT NULL);
CREATE TABLE IF NOT EXISTS personal_skill_versions(skill_id text NOT NULL,digest text NOT NULL,manifest jsonb NOT NULL,PRIMARY KEY(skill_id,digest));
CREATE TABLE IF NOT EXISTS personal_skill_archives(skill_id text NOT NULL,digest text NOT NULL,files jsonb NOT NULL,PRIMARY KEY(skill_id,digest),FOREIGN KEY(skill_id,digest) REFERENCES personal_skill_versions(skill_id,digest));
CREATE TABLE IF NOT EXISTS personal_scheduled_tasks(user_id text NOT NULL REFERENCES personal_user_state(user_id) ON DELETE CASCADE,schedule_id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(user_id,schedule_id));
CREATE TABLE IF NOT EXISTS personal_schedule_fires(user_id text NOT NULL REFERENCES personal_user_state(user_id) ON DELETE CASCADE,id text NOT NULL,schedule_id text NOT NULL,trigger text NOT NULL,scheduled_for bigint NOT NULL,data jsonb NOT NULL,PRIMARY KEY(user_id,id),UNIQUE(user_id,schedule_id,trigger,scheduled_for));
