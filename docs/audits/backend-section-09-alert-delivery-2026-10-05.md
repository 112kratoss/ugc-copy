# Section 9J — alert delivery and managed-job recovery

Baseline ece2c8a2 (9I candidate including merged 9H). Eleven local integration
cases exercise the actual alert delivery function, real loopback HTTP receiver,
PostgREST job-run persistence and database leases. No runtime defect was found in
these cases; this batch adds evidence, permanent tests and delivery-contract docs.

| Control | Observed result |
| --- | --- |
| Actual isolated health/cost/moderation collectors | Receiver gets normalized report; succeeded job summary persists |
| Collector exception | Failed job, no outbound request, released lease |
| Missing configured destination | Skipped job, no collector or HTTP call |
| Quiet summary / explicit notify-ok | Suppressed by default; explicit recovery delivery accepted |
| Receiver accepts 202 | Auth and dedupe headers arrive; delivered summary persists |
| Receiver rejects 503 then recovers | Failed then succeeded run; both outcomes durable |
| Receiver consumes body and closes before acknowledgement | Failed run; later dispatch repeats the same dedupe key |
| Receiver never acknowledges | Real five-second timeout; failed run and released lease |
| Overlapping dispatch while HTTP is pending | Second run skipped; one receiver request |
| Abandoned one-second test lease | First dispatch skipped, next succeeds after real expiry |
| SIGKILL after receiver receives request | Started row survives; immediate dispatch skipped, next succeeds after real two-second test lease expiry |

The killed process runs the actual job and collectors. Only its in-memory lease
TTL is shortened to two seconds; production remains 840 seconds. No fake clock
or manual lock-expiry update is used. Other transport cases use a deterministic
collector payload to isolate dispatch behavior. The database, HTTP transport,
managed wrapper and timeout implementation are real. No third-party service or
real recipient is contacted. Fixture job runs are removed and fixture-owned
locks are absent after every case.

Tests: backend-alert-delivery-postgrest.test.ts and its crash worker; invoke with
vitest.backend-alert-delivery-postgrest.config.ts plus explicit loopback
AUDIT_STORAGE_CONFIG and SUPABASE_TEST_DB_URL. This suite is an explicit local
integration run because Quality's DB-only stack omits Auth/PostgREST. Test
typechecking and scoped lint pass. Existing unit tests remain the normal CI gate.

A 2xx proves receiver acknowledgement, not a human notification. Lost replies
and process death permit repeated deliveries; the consumer must group the stable
dedupe key. There is no queue retaining every alert snapshot, and a transient
alert can disappear before the next collection. The runbook now makes those
limits explicit. This is not an actual external-sink certificate, a full
scheduler failure certificate, or proof of fencing an overlong live worker after
its lease expires. The existing no-third-party-monitoring decision is unchanged.

This adds alert-job evidence to JOB-01/JOB-02. The other eleven job-specific
recovery matrices and remaining budget/retention behavior keep those broader
obligations open. No migration, customer data repair or new production sink.
Private output: .audit-evidence/backend-social/alert-delivery-*.log.
