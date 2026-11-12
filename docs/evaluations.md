# Pi-Eval V1

Pi-Eval is native to Pi-Flow. The review stack follows RFC PR-01 through PR-06: contracts, datasets, isolation, durable jobs, Judge, reports and Studio. PR-07 real readonly sandbox acceptance and PR-08/V2 extensions remain gated; this release accepts only `executionProfile=mocked`. No production session/run/volume is created. Skill files, memory, subagents, MCP and user tokens are not loaded. Agent configuration and resource/version references are frozen and the effective restrictions are shown in reports.

## Deploy and roll back

Stop API/workers and back up the database before `npm run migrate` (or `npm run migrate:prod`). The existing runner discovers migration `016_personal_evaluations.sql`, and personal readiness requires schema **14**, evaluation tables and valid queue/history indexes. Shared `harness_*` schema stays unchanged. Deploy all API/workers together; do not mix v13 and v14 binaries. Compose fresh-volume initialization includes 016.

Flags default off:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVALS_ENABLED` | false | Register dataset, job and Studio routes |
| `EVAL_WORKER_ENABLED` | false | Permit dedicated worker startup |
| `EVAL_MAX_CASES_PER_JOB` | 100 | Server cap on expanded case runs, at most 100 |
| `EVAL_MAX_REPEATS` | 3 | Server cap, at most 3 |
| `EVAL_JUDGE_ENABLED` | false | Enable the separately budgeted Judge |
| `EVAL_JUDGE_MODEL` | unset | Approved `provider/modelId` catalog entry |
| `EVAL_JUDGE_REASONING_EFFORT` | unset | Optional low/medium/high; frozen into Judge configuration/version |
| `EVAL_ALLOW_READONLY_SANDBOX` | false | true is rejected: provider isolation is unaccepted |

Worker concurrency is intentionally fixed at one, with one active case per user enforced by a unique index. PostgreSQL is required for jobs, including Demo jobs. In-memory Demo supports dataset management. Run the API with `EVALS_ENABLED=true`; start a separate process with `EVALS_ENABLED=true EVAL_WORKER_ENABLED=true npm run eval-worker` after building. This entry point does not construct production Sandbox/MCP managers. Normal workers continue using `npm run worker`. For Compose Demo, set `DEV_TOKEN` and run `EVALS_ENABLED=true docker compose -f compose.demo.yml --profile evals up --build`; the `evals` profile starts a dedicated worker.

Roll back by disabling flags and stopping the Eval Worker while preserving tables and history. Do not drop tables or downgrade the schema under active processes. Schema downgrade requires a separate offline, reviewed compatibility plan.

## Studio and API

Open `/evals/ui`, enter the existing user API token, and create a dataset. Saving a draft requires the last `revision`; a stale write returns 409. Publish with `POST /api/v1/evals/suites/:id/versions` and `{ "revision": 1 }`. Published versions never change. Deleting a suite hides it from management but preserves versions and job history; its owner can still enumerate the archived versions with `GET /api/v1/evals/suites/:id/versions`, including pagination. User scope is always the authenticated identity, including for administrators.

Example draft:

```json
{"name":"Greeting","cases":[{"caseId":"hello","inputs":"Hello","graders":[{"id":"greeting","type":"contains","value":"Hello"}],"mocks":{"read":{"text":"Fixture response"}},"passThreshold":0.5}]}
```

A case is one text input in a fresh in-memory context. Maximums: 100 cases before repeat expansion, 250KB per draft, 64KB text fields, 32 graders, 100 tool calls per execution. `mocks` accepts only read/ls/grep/find; a mock must also be in the frozen and live Agent allowlists and pass the platform kill-switch. Mock tools return fixed JSON and never access files or the network. Redacted scalar arguments and hashes are available only through authenticated case details; SSE tool events carry identifiers/status only. Traces describe the mocked execution, not production tool behavior.

Start a job with an `Idempotency-Key` header and:

```json
{"suiteId":"<uuid>","suiteVersion":1,"agentId":"assistant","repeat":1,"executionProfile":"mocked","limits":{"maxTokens":20000,"maxModelCalls":30,"maxJudgeCalls":0,"maxCostEstimateUsd":1,"maxDurationSeconds":900}}
```

Same key/request returns the original job; changed payload returns 409. Job creation freezes Agent/model/gateway secret-version references, suite digest (including fixtures/mocks and graders), restrictions, skills/bundle metadata and prices. Secrets remain in the vault. Request limits cannot raise server caps. Real model execution requires a versioned catalog entry and a configured `USAGE_POLICY_JSON.prices` entry for each selected model.

All routes are under `/api/v1/evals`: suites CRUD, versions list/publish/get, jobs list/create/get/cancel, job cases/report/events, and POST compare with `baselineJobId`/`candidateJobId`. Lists use bounded `offset` and `limit` (1..100). Draft PATCH updates only supplied fields and requires `revision`. The maximum expanded job size makes reports bounded to 100 case rows; they do not load unrelated user history.

Job list offsets count authorized rows. The API resolves live Agent/model read permissions once and applies them in SQL before LIMIT/OFFSET, using `personal_eval_jobs_agent_history`; it does not scan and authorize individual historical jobs. No allowed Agents returns an empty page without querying job history. The migration runner replays idempotent migrations, so rerun `npm run migrate` to add this index to an existing schema; readiness requires the index. Repeating an idempotent job POST returns the same current state/cancellation projection as GET. Studio provides Agent and version pagination, and comparison inputs retain selections across job pages and accept known Job IDs. New datasets start from the default example rather than copying the previous draft. Transient polling failures retry automatically; a successful manual refresh resumes polling after an authorization failure.

Every Studio API response is fenced by the account generation, including lists and mutation responses. Switching accounts clears the previous account's selections and ignores its late responses/errors. Studio exposes `maxModelCalls` (1..100, default 100 in Studio; the API default remains 30). An in-flight guard coalesces repeated Start clicks, and an unchanged request reuses its idempotency key after an ambiguous failure; a completed operation or changed request starts a new intent.

Judge configuration is frozen only when the published Suite contains `llm_judge`; a global Judge flag or broken Judge catalog entry cannot block or reserve Judge costs for a native-only Suite. Before target/Judge execution, each frozen gateway reference must still match the currently approved catalog entry, including before decrypting its secret and issuing a model budget ticket. Rotating a gateway invalidates execution of older Eval snapshots with `EVAL_GATEWAY_REVOKED`. Old results remain readable under live identity/Agent/model read permissions; retained secret versions cannot authorize further execution by themselves. A required Judge must also have a price entry before job creation; missing Judge prices return `MODEL_PRICE_REQUIRED` before target execution.

Events use job-local monotonic `eventId`; reconnect with `Last-Event-ID` or `?after=`. Both REST and SSE verify live identity and Agent authorization. Long streams recheck once per second and close on token expiry; slow readers are disconnected and can resume. Events and case state changes commit together. Consumer disconnects do not stop execution.

## Scoring semantics

Native graders: exact, contains, json_match, json_schema, tool_called/tool_not_called, trajectory, latency (ms), tokens, cost (USD estimate), llm_judge. `json_match.expected` is already a JSON value: a string such as `"42"` remains a string, while only model output text is parsed as JSON. Positive `tool_called` counts completed calls; `tool_not_called` checks every attempt, including denied/failed calls. Trajectory graders continue to describe all attempted calls. JSON equality sorts object keys and preserves types/missing fields. `ignoreFields` removes explicitly named top-level fields only. Schema validation is local: remote refs, regex/format keywords and excessive nesting are rejected; no remote loading or custom executable keywords. Arbitrary scripts and regex graders are unsupported.

Trajectory `strict` uses monotonic sequence order; `unordered` requires the same multiset. `subset` requires expected calls to be included in observed calls; `superset` requires observed calls to be included in expected calls. Each occurrence matches only once, including overlapping argument constraints.

Argument assertions compare the original canonical argument digest, including denied attempts; the redacted/truncated argument display is never used as the assertion value when a digest exists. Schema keyword restrictions apply only at schema positions, so object properties named `format` or `pattern` and literal JSON data remain valid. Native grader version **4** includes these semantics and the Judge aggregation constraint below. Workers reject queued jobs frozen against an unavailable grader version with `EVAL_GRADER_VERSION_UNAVAILABLE` before any model request; recreate those jobs after upgrading. Historical results remain readable, and comparisons across grader versions are incomparable. Publication and job creation both run the same local schema safety checks and Ajv compilation used by grading. Invalid or unsupported schemas fail with `EVAL_INVALID_GRADER_SCHEMA` before budget holds or model execution, including legacy published versions. Drafts may still contain schemas being edited.

Positive grader weights determine the quality average; weight zero is observation-only. `hard=true` failures override the mean. A case passes when its quality score reaches `passThreshold` (default 0.5), no hard assertion fails, and no grader errors occur. All-zero weights/no scorable output is GRADING_ERROR. A grader ERROR/SKIPPED has null score/pass; execution errors and grading errors stay separate. The final output is the last complete assistant message with stopReason=stop; tool-use, truncated and incomplete messages cannot be final output.

A positive-weight `llm_judge` must also pass its own threshold and return `passed=true`; failure cannot be overridden by the case mean, even when `hard=false`. Its continuous score remains available in reports. A zero-weight Judge is observation-only unless `hard=true`.

Judge model/template/rubric/gateway versions are retained. Judge inputs are JSON data under fixed system instructions, with no tools/skills/memory. Only malformed structured output is retried once, as a Judge-only request; errors remain null scores. Prompt injection and statistical model bias cannot be eliminated by formatting: use deterministic hard assertions for safety constraints. Temperature zero does not promise reproducibility.

Reports show passed/total, graded denominator, execution/grading/cancellation rates, per-grader scores, repeated-run mean/variance, duration quantiles and separate target/Judge requests/tokens/costs. Unknown usage is conservative and marked estimated. Costs are estimates, not financial billing. Baseline comparison checks suite/fixture/grader/Judge/environment/repeat compatibility and aligns `(caseId,repeatIndex)`; incompatible or unfinished comparisons have `gate=null`. Comparable gates fail on regressions, lower scores or candidate errors/cancellations.

Suite `passRate` and `avgScoreOnGraded` use the frozen case weights. Raw `passed`, `denominators.total/graded`, error rates and `unweightedPassRate`/`unweightedAvgScoreOnGraded` retain unweighted counts. `weightedTotal/weightedGraded` make the weighted denominators explicit. Weight-zero cases still execute and retain all evidence, errors and usage, but do not affect quality or regression gates; an all-zero-weight comparison has `gate=null` and `NO_WEIGHTED_CASES`. Any positive-weight case regression, lower score or candidate error/cancellation fails the gate. Repeat groups include requested/scored/ungraded counts, execution/grading errors, cancellations and pending runs, even for all-error groups. Their mean describes scored runs only; variance is null until every requested repeat is scored.

A cancelled/failed baseline or any ungraded positive-weight baseline case makes comparison incomparable with `BASELINE_NOT_GRADED` and `gate=null`. Invalid baseline cases are not labelled improvements. A fully graded failed assertion with a finite score remains a valid baseline for measuring a later improvement.

## Shared budgets and failures

Job creation atomically places a maximum token/cost hold in **personal_usage_requests**, under the same `personal_user_state` lock used by normal Run reservations. Each target/Judge request transfers allowance from that hold into a separate request reservation, retaining the shared user daily/monthly budget domain. Confirmed actual usage replenishes unspent allowance; unknown usage stays charged. Job termination releases only the unused hold. All prices and credential references are frozen. Usage without a reliable vendor report stays unknown, including synthetic Demo usage.

Each request rechecks the current daily/monthly caps while holding the same user lock, including when its hold was created in an earlier period. Same-period transfers count the reduced hold plus the request exactly once. Target and Judge maintain separate per-case model token allowances while sharing the job's overall token/cost hold and user budgets. A model is free only when input, output, cache-read and cache-write prices are all zero; all selected target/Judge models must be free for the hold to be zero. Request estimates charge each estimated input token at the highest applicable input/cache rate, plus output cost, before transferring the reservation.

Cases have worker/generation/expiry fencing. Every heartbeat, model request, tool event and completion checks the fence. Cancellation persists before stopping new cases and signals active work. Expired started cases become EXECUTION_ERROR/LEASE_LOST; only untouched cases may continue. Target execution is never automatically retried. No remote sandbox resource is allocated by the mocked profile; the reserved sandbox lease table cannot enable a provider through a client flag. Lease recovery preserves the target result and classifies expired RUNNING cases as EXECUTION_ERROR and expired GRADING cases as GRADING_ERROR, both with LEASE_LOST.

## Acceptance

Use a dedicated disposable database, never production:

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm run check
npm test
npm run build
npm run smoke
npm run smoke:eval
```

`TEST_DATABASE_URL` enables isolated-schema Eval integration tests: tenant/FK boundaries, immutable datasets, concurrent claims, stale fencing, non-replay recovery, cancellation, budgets, API/SSE, reports and browser Studio at mobile width with keyboard/XSS checks. CI runs the same new tests through its existing no-skip PostgreSQL harness. `smoke:eval` starts the built API and separate built Eval Worker against an isolated schema and drives the full Demo lifecycle over HTTP. Real provider isolation acceptance has not been performed. Real DeepSeek model acceptance is recorded below. No 1k/10k-case historical performance SLA is claimed.

Before enabling PR-07, supply and test provider-enforced network/workspace/credential isolation, fixture ownership, temporary resource capacity reservations, late-callback fencing, unknown-resource reconciliation, live revocation and timeout/cleanup behavior. V2 CLI/JSONL/multi-turn work is outside this release.

The review stack is #63 → #64 → #65 → #66 → #67 → #68; merge in that order and enable flags only after the complete accepted stack is deployed.

## Real DeepSeek acceptance

An opt-in run against `deepseek/deepseek-flash` with `reasoningEffort=high` passed all three cases: exact text, one fixed mock read with argument/order checks, and a separately budgeted LLM Judge. The Agent made 4 requests (1308 tokens), Judge 1 request (485 tokens), with confirmed usage and no unknown requests. The configured price estimate totaled USD 0.00074; this is not a provider invoice. See [sanitized report](eval-deepseek-acceptance.json).

The run also checked cancellation, request idempotency, immutable reasoning snapshots, SSE tool evidence, comparison, cross-user denial, budget rejection before a remote call, live Agent revocation, rejected readonly profiles, and zero production Session/Run records. It used a disposable PostgreSQL schema, the real Pi runtime, and a separate Eval Worker; tools were in-memory fixtures, not a real Sandbox.

`AgentConfig.reasoningEffort` is optional (`low`, `medium`, `high`) and is frozen with the Agent snapshot. The approved gateway preserves native model compatibility/thinking maps when an effort is selected and rejects explicitly unsupported native levels. A transport contract test verifies DeepSeek sends `thinking.type=enabled` and `reasoning_effort=high`. Omitting the option keeps the previous gateway reasoning behavior.

To repeat after building, set `TEST_DATABASE_URL` to a disposable database and run `NODE_USE_ENV_PROXY=1 npm run smoke:eval:deepseek`; supply the API key through stdin (use a terminal with echo disabled). The script seals credentials only in its disposable schema, drops the schema and worker afterward, and writes a credential-free report to `work/eval-deepseek-report.json`. It is opt-in and is not run automatically in credential-free CI.


## Worker transient failures

The dedicated worker retries transient PostgreSQL connection, availability, serialization/deadlock and timeout failures with an abortable exponential backoff from 250ms to 5s. Structured `eval_poll` logs use `EVAL_DATABASE_TRANSIENT` without serializing driver errors or credentials. Successful ticks reset the backoff. This retries polling and lease recovery, never target model execution. Permanent schema/programming errors still exit and require configuration/code correction. Configure the process supervisor to restart failures, including startup failures, when deploying the standalone worker.

Studio saves capture the submitted Suite ID and selection generation. A late PATCH/POST response cannot reselect the original Suite after the user has switched elsewhere; the original server-side save still completes normally.
