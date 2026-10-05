# Section 9A — shared job lease controls

Seven actual local PostgREST/database tests pass in
`src/__tests__/backend-job-lock-postgrest.test.ts`, using
`vitest.backend-job-lock-postgrest.config.ts` and the isolated audit API/database.
No runtime defect was reproduced and no migration was changed.

The real RPC and wrapper controls establish one winner among eight concurrent
owners, renewal by the current owner, foreign-release denial, stale-owner release
denial after replacement, lease release on a thrown task, retry success, exclusion
of a competing task, invalid-TTL rejection, and anonymous direct-call denial.

The worker-death case starts a separate Node process that acquires a two-second
lease via PostgREST, waits for its acquisition acknowledgement, kills it with
SIGKILL, verifies immediate replacement is refused, then verifies replacement
succeeds after real elapsed expiry. That case changes no database clock or lease
timestamp. A separate stale-owner test explicitly expires its isolated fixture
row to exercise ownership replacement without conflating it with the kill test.
All fixture lock rows are removed and absence checked after each test.

Test typecheck and scoped lint pass. Raw output is preserved under
`.audit-evidence/backend-social/job-lock-*`. This certifies the shared primitive
only. It does not prove business idempotency after lease expiry, task interruption
at each job's write/provider boundary, per-job poison-work progress, provider
receipts, scheduler crash isolation or alert delivery. JOB-01/02/03 remain open;
the next matrix must cover all twelve registered jobs explicitly.
