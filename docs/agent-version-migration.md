# Agent / Task version migration

Stop API and Worker writers before upgrading to schema 5, back up the database, then run `npm run migrate` with DATABASE_URL. Resume the updated API/Workers only after migration completes. Mixed old/new writers are unsupported because old Workers derive execution configuration from Session.

Migration 005 preserves all Session IDs, entries, Todo, Workspace and Volume records. Every legacy AgentVersion becomes a logical Agent whose ID and activeVersionId equal that legacy version ID. Versions already attached to logical Agents retain their identity and active pointer. Sessions gain agentId/effectiveVersionId; Runs gain pinned agentVersionId, capabilities, taskId and rootRunId. The task chain is reconstructed through parentRunId and resumedFrom Interaction.runId, including queued and waiting tasks. The migration is repeatable and does not rewrite immutable configuration or upgrade existing tasks.

Publish successors using `POST /api/v1/admin/agents/{agentId}/versions`. Independent root submissions resolve the active version; continuations retain the migrated version. No automatic merge of separate legacy versions into one logical Agent is attempted. Cross-bundle changes return WORKSPACE_BUNDLE_MIGRATION_REQUIRED; provision a matching Workspace rather than silently mixing bundles in a persistent Volume.

The existing offline normalized rollback preserves current JSON records, including new version/task metadata. Reverting application binaries while upgraded tasks exist is unsupported: old Workers do not honor Run-pinned versions. Restore the pre-upgrade backup for a full application rollback.
