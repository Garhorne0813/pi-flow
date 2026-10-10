# CI quality checks

All pull requests (including stacked PRs), merge queue commits, main/work pushes,
and manual runs trigger the available workflows. There are no path filters.
The stable required check names are quality, vendor and postgres-fault-load.
Only superseded PR runs are cancelled; main/work push evidence is retained.

- quality: Node 24, locked installation, TypeScript, JavaScript syntax, high/critical
  dependency audit, real PostgreSQL 17 migration, full regression suite, build and
  Demo smoke. scripts/ci-tests.mjs requires TEST_DATABASE_URL and rejects failed,
  cancelled, skipped or TODO tests, missing summaries and empty suites.
- vendor: archive/installed dependency integrity, an explicit archive tampering
  negative check, upstream source rebuild/provenance, remote contract regressions
  and SBOM. The modified archive is restored even on failure.
- postgres-fault-load: actual Worker process crash recovery and real HTTP/PG
  SSE replay/reconnect at 10/100/500 clients. The integration branch also runs
  large-history Worker reads and SSE history replay after normalized stores land.

TAP, JUnit, negative integrity results, SBOM and acceptance reports are uploaded
with the commit SHA and retained for 14 days, including after check failures.
Reports contain synthetic fixtures, not production credentials. Failure exits
from commands and pipelines propagate to the job; uploads cannot turn failures
into success. A failed setup may have no reports to upload.

For a dedicated migrated local test database:

```sh
TEST_DATABASE_URL=postgres://... node scripts/ci-tests.mjs
```

Never point CI or acceptance fixtures at production. CI passes do not complete
real Cube/MCP/gateway or production backup/load acceptance (#18). GitHub branch
protection must separately require the three check names; workflow configuration
alone does not enable remote protection.
