# Section 6F — ambiguity-marker write recovery

Status: locally verified; PR, exact-main Quality and production release pending.

## Reproduced defects

An ambiguous provider submission is already charged against a generation hold.
If `mark_generation_submission_unknown` failed, threw, returned no usable status,
or committed but lost its response, the start service immediately refunded the
hold and cleared its request key. A later callback could not resume that terminal
row. Twelve new real-PostgreSQL cases failed before the fix, covering standalone
and template starts with five transient fault shapes and a persistent outage.

An actual local HTTP image start with an unreadable provider receipt and failed
marker write returned 500, refunded the 8-credit reservation, and cleared the
request key. A signed callback returned 200 but left the generation failed with
no completion job. This reproduces the defect through the actual Next routes.

Keeping the reservation alone exposed a second recovery gap: the expiry job
would refund an unmarked row after 45 minutes, leaving a subsequent callback
ineligible for the provider-cost reconciliation ledger. Three real-database
regressions failed before the reaper fix: restoring a missing marker, deferring
refund during its outage, and a callback racing the marker write.

## Fix

The start service retries the idempotent marker RPC up to three times. A lost
write response can be confirmed by `already_marked`; an attached callback or
terminal row retains its existing ownership. If all attempts fail, the service
preserves the reservation and request key, with recovery metadata for direct,
workflow and template callers. It returns the existing `submission_pending`
code, with cautious status-only wording when the database state is unconfirmed.
It does not promise a confirmed credit balance or invite duplicate submission.
Explicit provider rejection continues to use immediate settlement/refund.

Before refunding an expired taskless row, the reaper restores a missing marker.
An unconfirmed marker defers settlement to a later cron attempt; a callback that
already attached its task takes ownership. This uses existing locked SQL RPCs.
The strict 45-minute eligibility threshold is unchanged. A persistent database
outage can extend that hold until marking succeeds or a callback takes over.
All taskless expired starts are conservatively counted as submission-unknown,
including those that may never have reached the provider. Only an actual late
callback creates a provider-cost reconciliation record.

## Verification and limits

All 183 focused web/database cases pass, including 26 real-DB start cases and
13 real-DB grace cases; 120 mobile contract cases, app/test/mobile typing and
targeted lint pass. The workflow runner retains the generation link for both
confirmed and unconfirmed marker outcomes. Both clients consume the shared 409
fixtures; no mobile runtime change or OTA is needed. No migration is needed.

Actual HTTP retests for both transient and persistent marker outages return 409
`submission_pending`, accept the signed callback into processing, then return
200 same-key replay. Each uses one provider call and one 8-credit hold (balance
492 from 500). The transient case records the marker on attempt two; persistent
failure makes three attempts and keeps cautious wording. Local fixtures are
removed and the HTTP server is stopped.

The HTTP harness uses real Next routes and PostgreSQL through a local REST
bridge; Auth is stubbed for a synthetic identity, provider fetch is redirected
locally, and nonlocal fetch is blocked. Database tests invoke real reservation,
attachment, settlement and reconciliation functions. This does not establish
genuine Kie/edge delivery or production auth. The first attempted baseline run
failed because Docker was stopped; its separate log is not defect evidence.
One regression rerun caught an extra unit-fixture row introduced while updating
the expected RPC sequence; it was corrected before the passing final run.

Read-only production inventory remains seven unmarked refunded taskless rows,
zero marked ambiguous rows and zero active taskless rows. The seven also match
legitimate rejection and are not attributed to this defect. No customer repair
or production fixture was performed. Private evidence is preserved in
`.audit-evidence/backend-section-06f/`.

Next: actual worker process termination around dispatch/attachment and durable
completion leases. The broader generation audit and genuine provider delivery
remain open; this batch is not a subsystem sign-off.
