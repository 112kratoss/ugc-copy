# Section 9N — provider verification history and delivery behavior

Baseline 9cc05bcf. Actual PostgREST/SQL plus a local HTTP receiver reproduce a
history-loss defect: with 101 recent observations for one model and an older
seven-failure observation for another, the release-wide latest-100 selection
forgets the latter. A new error is counted as failure one and the degraded count
incorrectly stays zero. The permanent regression fails before the fix. This is
an uneven-history fixture, not evidence of a production incident.

Migration 20261005190934 adds latest_generation_model_provider_checks(uuid),
a service-only stable invoker function with an empty search path. For each model
in the selected release it uses the existing release/model/timestamp index to
read the newest observation; identity breaks equal timestamp ties. JSON output
avoids a shared history-row limit. The worker uses this lookup before its HEAD
requests. No provider request or discrepancy formula changes.

Fourteen actual local HTTP/PostgREST controls pass: missing release, no entries,
manual and rejected endpoint configurations, successful HEAD/fingerprint/change,
404 and 503 streak/recovery, network loss with sanitized diagnostics, the real
eight-second timeout, failed bulk insert, committed insert with lost reply,
history-read failure/retry, sparse-history preservation and equal-timestamp
ordering. The allowlisted provider host is redirected by a test transport to a
loopback receiver; no Kie request or paid generation occurs. Database queries,
atomic inserts and HTTP timeouts are real. The active local release is restored
and fixture releases, entries and checks are removed after every case.

Lost acknowledgement can leave a committed snapshot; a fresh retry makes a new
observation and can increase the streak. This is repeated observation, not an
exactly-once result. It does not establish independent elapsed-time confirmations.

Validation: all 14 actual controls, 15 pgTAP controls for the new lookup, the
migration-content test, app/test typechecking and scoped lint pass. Clean replay
and all 2,102 SQL assertions across 98 files pass; public schema diff is empty.
The initial pgTAP fixture needed an explicit JSONB cast in its UNION before it
could execute; no runtime fix was driven by that fixture error. Private evidence:
.audit-evidence/backend-social/model-verification-*.

Seven bounded production rollback controls are prepared and pass locally. They
only insert a draft fixture release using two existing model identities and never
activate it. The migration plan has this one pending migration, no out-of-order
entry. PR, CI and production release verification remain required.

Open scope: model-set paging/capacity, aggregate request concurrency, overlapping
workers after lease expiry, process death during checks, catalog changes during
a run and real provider availability. The job currently selects catalog entries
with one PostgREST request and starts them together; these bounds are not certified.
JOB-02 remains failed until this named defect is released and verified, then its
broader obligation still requires evidence.
