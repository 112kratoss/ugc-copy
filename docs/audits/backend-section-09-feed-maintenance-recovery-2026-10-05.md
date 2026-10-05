# Section 9M — feed-maintenance phase recovery

Baseline 93f1e3d3, including candidate 9L. Seventeen actual local PostgREST/SQL
controls pass without another runtime change. The fixture has one creator,
two served feed deliveries, one open and one completed image generation. A
historical as-of isolates the source window; algorithm IDs isolate rollup cleanup.

For each of the six RPC phases (post stats, engagement stats, creator stats,
interest weights, daily rollup, retention), a transport failure before the RPC
prevents later phases. A fresh run completes and a second run retains exactly
two deliveries and one open. The cache-invalidation callback runs only after the
three stats phases succeeded. The callback is a spy; actual cache consumers are
not covered by this result.

Six additional cases launch the real maintenance function in separate processes,
wait for the chosen RPC to commit, and send SIGKILL. Restart finishes the chain
and retains two deliveries/one open with two image-interest dimensions. A final
case commits the daily rollup but loses its acknowledgement; pruning is not
called on that run, and retry does not duplicate the committed aggregates.

Four additional controls exercise the actual managed-job entrypoint: phase
failure with durable failed status followed by successful retry; overlapping
workers with the second skipped before business SQL; abandoned-lease expiry;
and SIGKILL after the first committed RPC under a managed lease, then rejection
before expiry and successful recovery afterward. The killed run remains `started`,
while the later run records success. The child alone uses a two-second lease;
production retains 840 seconds. SQL clocks and lease waits are real. The parent
application clock is fixed to the fixture's 2005 window (outside automatic job
history pruning), with cache invalidation and logging controlled.

All fixture users, generations, sessions, delivery facts, algorithm versions,
daily buckets and job-history rows are removed; no fixture-owned lock remains. No provider or production endpoint is contacted.
The real timeout/retry body is not mocked; only the documented cache callback
and targeted PostgREST response are controlled. Test types and scoped lint pass.
Use vitest.feed-maintenance-postgrest.config.ts with the explicit loopback
AUDIT_STORAGE_CONFIG and SUPABASE_TEST_DB_URL. Private logs are
.audit-evidence/backend-social/feed-maintenance-*.

This covers business-phase interruption/retry and actual worker death. It does
not establish cache effects in live consumers, production-scale query duration,
all retention cutoffs, or full managed-job fencing after lease expiry. Shared
lease evidence applies only to that common wrapper. JOB-01/JOB-02 and broader
feed/retention obligations remain open. No migration or runtime change in 9M.
