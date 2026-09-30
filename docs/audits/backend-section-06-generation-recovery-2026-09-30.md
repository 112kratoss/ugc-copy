# Section 6A — initial generation recovery concurrency checks

2026-09-30. Checkout: `65890e3146309b5e62fac155f72983de4475a7a1`.
Status: initial local PostgreSQL checks pass; no new defect or fix established.

## Completion queue

On the isolated audit database, concurrent waves of 20 callers verified:

- Duplicate callbacks produce one durable completion job.
- Competing workers produce one live lease holder.
- Duplicate callbacks preserve that lease and attempt count.
- An expired lease has one takeover winner; the old owner cannot finish it.
- An unsuccessful attempt schedules a future retry and cannot be claimed early.
- A successful retry remains terminal under another callback wave.

Lease expiry was simulated by backdating only the synthetic job's lock. The
fixture job was removed and its absence checked. RPCs ran as service_role;
fixture setup and cleanup used the local database owner.

## Generation settlement

Three separate synthetic generations each received 20 concurrent decisions:
all failures, all successes, and mixed failure/success. Failures credited the
120-credit cost once, successes credited nothing, and the mixed run settled as
failed with one refund. Subsequent failure/success replay preserved status,
output and balance in all three cases. The mixed test did not observe both
possible winners. User/profile/generation fixture counts were zero after cleanup.

## Provider task attachment

Twenty distinct task IDs raced to attach to one generation: one attached and
19 returned prediction conflicts. Twenty generations then raced for one task
ID: again one attached and 19 conflicted. Finally, attachment competed with
start-failure settlement on an ambiguously submitted generation. Attachment
won; the generation remained processing, no refund was issued, and the task
identity was retained. All fixtures were removed. This tests the SQL boundary,
not the callback HTTP handler or the reaper's grace-period admission logic.

## Limits and next checks

These are direct database checks. They do not certify provider delivery,
edge-to-Vercel callbacks, storage imports or route/worker crash recovery. No
provider calls or production writes were made. Existing sequential pgTAP tests
cover related invariants; these probes add contention evidence.

Next exercise cross-layer callback/start handling and ambiguous submission
grace expiry, followed by output import partial failures and worker recovery.
Source/test mapping and executable local probes are preserved privately in
`.audit-evidence/backend-section-05l/next-audit-obligations.md` and
`.audit-evidence/backend-section-06a/`.
