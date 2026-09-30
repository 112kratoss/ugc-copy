# Section 6D — ambiguous-start grace and late callback recovery

Status: local reproduction and fix verified; release gates pending.

## Finding

A provider callback arriving after an ambiguous start has been refunded must
leave a durable provider-cost reconciliation. The webhook previously returned
HTTP 200 even when that record failed to write. A temporary database outage could
therefore acknowledge delivery while losing the discrepancy.

Five real-PostgreSQL regressions failed before implementation: an RPC error,
thrown transport error, empty response, unknown response status, and a lost
response after a successful insert. A signed POST to the actual local Next.js
webhook reproduced HTTP 200 with zero reconciliation rows during an injected
ledger outage. The local HTTP bridge executes real service-role SQL; only the
first reconciliation request is faulted. No external provider is contacted.

## Fix and evidence

The callback now returns HTTP 503 unless the database confirms `recorded`,
`already_recorded`, `not_applicable`, or `missing`. Confirmed benign callbacks
still return 200. The existing unique constraint makes retry after a lost insert
response safe. This changes neither refund settlement nor completion admission.
The existing Supabase edge forwarder propagates this HTTP status unchanged.

The signed HTTP retest returns 503 during the outage, then 200 on manual
redelivery and 200 on duplicate delivery. Exactly one reconciliation remains;
the refunded balance stays at 620 throughout. Synthetic users, generations and
reconciliations are removed afterwards.

Ten permanent database cases also cover the strict 45-minute selection boundary
(one millisecond before, exactly at, and one millisecond after), a callback
between reaper selection and settlement, and the reverse ordering. Callback
attachment prevents a stale refund; when the reaper wins, refund happens once,
the request key clears, no completion job is admitted, and replay leaves one
reconciliation. These are controlled interleavings on one database connection,
not simultaneous connection races; Section 6A holds the separate contention
evidence. The new cases run in Quality's real-database job.

Local validation: 38 focused checks across six files, application/test type
checks and targeted lint. One terminal-callback route fixture needed an explicit
benign reconciliation response instead of its generic attachment response;
its mock type now permits each RPC's actual optional fields.

A read-only production aggregate found zero marked ambiguous generations,
zero refunded ambiguous generations, and zero reconciliation rows. No customer
repair is indicated by that snapshot. This cannot establish whether historical
delivery was lost. No migration, mobile binary or OTA is required.

Private evidence: `.audit-evidence/backend-section-06d/`, including before/after
database logs, signed HTTP results, server logs and fixture cleanup. Genuine
provider redelivery and edge-to-Vercel signed delivery remain unverified; the
HTTP retry here is manual and local. Start-route idempotency/unknown-response
handling and actual worker termination remain subsequent audit obligations.
