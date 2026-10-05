# Section 9G — push maintenance progress

Baseline: initial-send candidate `fd3aa2a2` (PR #361), incorporating main
`177d6c98`. Four actual local PostgREST/SQL reproductions establish that one
record failure aborts the whole push maintenance pass before unrelated work.
Each case runs the actual service three times with the same oldest failed row
and verifies the healthy next row remains unchanged after every pass.

1. A saved initial outcome at the attempt cap fails its finalize RPC. The next
   saved accepted outcome remains unfinalized; receipt scanning, retries and
   retention never run.
2. A stale receipt fails its per-row update. A healthy due receipt remains
   pending without even a provider lookup; retries and retention never run.
3. An oldest retry fails its claim RPC. The next eligible delivery stays at its
   original attempt count without a claim; retention never runs.
4. A full batch of 100 saved results fails finalization, with a healthy 101st
   result beyond the scan limit. All 101 remain unfinalized across three passes.

The injected fault targets exactly the selected record through the real
Supabase client's HTTP transport; all other requests reach the isolated local
API and SQL confirms durable state. This demonstrates application failure
isolation, not an actual production outage or a particular database fault cause.
No provider call occurred in any case. Fixtures cascade-delete after each case
and SQL confirms no delivery remains for the fixture owner.

Evidence: `.audit-evidence/backend-social/mobile-push-poison-probe.test.ts`,
`mobile-push-poison.config.ts`, `mobile-push-poison-baseline.log`. The four passing
characterizations assert the defective behavior; they are not safety tests.
The baseline preceded the candidate below.

JOB-02 returns to failed. Fix design must preserve durable attempt accounting,
claim fencing and token-retirement recovery while allowing independent records
and phases to progress and reporting partial failures observably. Catching errors
within the first batch alone is insufficient: a whole batch of persistently
failing oldest rows can still starve later rows. Verify bounded progress across
that boundary, recoverability of failed work, global outage behavior, retry
budgets, and unchanged successful delivery/receipt semantics before release.

## Candidate fix

Migration `20261005092947_advance_mobile_push_maintenance_scans.sql` adds a
service-only scan-state table and invoker RPC. Recovery, receipt and retry scans
have independent positions ordered by immutable `(created_at, id)`. Each sweep
captures its final eligible key, so new arrivals cannot extend it forever and
postpone revisiting old failures. The next call continues after the saved key;
an exhausted sweep wraps once. Each RPC serializes its scan-state row, advances
before returning work, and holds no lock over provider calls. Bounds remain
100 recovery/retry rows and at most 1,000 receipts. Three partial indexes support
the candidate predicates and ordering. The service role cannot delete scan state;
anon/authenticated cannot read it or execute the scanner. RLS is enabled.

Per-record failure no longer aborts the batch. Independent phases run even when
another phase fails. The worker then throws a typed error with progress counts,
failed phases, total failures and at most ten sample errors. The managed job
persists that partial summary with status `failed`, instead of marking a partial
pass successful or discarding the completed work. A provider receipt lookup
failure also preserves already-completed stale receipt counts.

Scan advancement is not completion or delivery ownership. The existing durable
send claims, attempt budget and outcome finalization still own those boundaries.
A crash after advancing can defer unfinished rows until the next finite sweep;
it cannot erase their work. Continuous database failure can prevent progress,
but no error is reclassified as success. Concurrent scans serialize positions;
very small queues may wrap and be revisited by another caller, so delivery claims
remain required. This does not promise exactly-once receipts or a universal
whole-job wall-clock deadline. Genuine provider/device delivery remains open.

## Candidate evidence

Eight actual PostgREST/SQL cases pass: the four failing-baseline regressions;
partial summary persisted by the real managed-job wrapper with lease release;
two concurrent scanner callers; phase-wide scan outage with independent retry
and retention progress; and real SIGKILL after a committed 100-row scan, followed
by the healthy 101st row and then recovery of all abandoned rows. Provider replies
and targeted database failures are injected. The scan crash test performs no
provider call, waits for child exit, and fixtures are removed.

All prior 16 retry-claim/worker controls (including real lease expiry), nine
initial-send cases and four receipt-recovery cases pass. Ninety-nine focused
notification, route, job and migration tests pass, as do app/test types and scoped
lint. Clean replay and all 2,046 pgTAP checks across 95 files pass, including 23
new scan controls covering grants/RLS, limits, tied timestamps, repeated failures,
fixed sweep boundary, arrivals, wraparound, independent phases and receipt age.
Clean-replay public schema diff reports no drift.
An initial draft SQL syntax error was corrected before applying the local draft;
unit query mocks were adapted to the new RPC, and a concurrency test was corrected
to assert key order rather than nondeterministic Promise completion order.

Private evidence: `.audit-evidence/backend-social/mobile-push-progress-*`.
This candidate needs exact-head CI, standard release and production verification.
It does not close the whole JOB-02/03 matrices.

PR #362 first-head Quality 37292884858 passed DB/mobile/E2E but failed four
older receipt write-failure tests: their mock client lacked the new scan RPC.
The remaining 7,421 web cases passed. The four fixtures now return the same rows
through that RPC, preserving all failure and write-order assertions. The expanded
99-case focused suite, lint and test types pass. Fresh full CI is required for
this corrected head; the initial failing run is not release evidence.
