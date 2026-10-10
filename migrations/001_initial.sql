-- Transactional tenant aggregates for the first release. All mutations are serialized
-- per tenant. Split runs/events/audit into indexed tables before large-scale rollout.
CREATE TABLE IF NOT EXISTS harness_tenants (
 tenant_id text PRIMARY KEY,
 state jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Shared across tenants and worker processes. Reserved and uncertain outcomes
-- consume quota until the remote operation is confirmed, never expire blindly.
CREATE TABLE IF NOT EXISTS harness_sandbox_capacity (
 id integer PRIMARY KEY CHECK (id = 1),
 state jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_schema (
 id integer PRIMARY KEY CHECK (id = 1), version integer NOT NULL
);
INSERT INTO harness_schema(id,version) VALUES(1,1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS harness_worker_health (
 worker_id text PRIMARY KEY, health jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS harness_worker_health_updated ON harness_worker_health(updated_at);
