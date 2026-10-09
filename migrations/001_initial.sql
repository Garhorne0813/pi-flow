-- Transactional tenant aggregates for the first release. All mutations are serialized
-- per tenant. Split runs/events/audit into indexed tables before large-scale rollout.
CREATE TABLE IF NOT EXISTS harness_tenants (
 tenant_id text PRIMARY KEY,
 state jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
