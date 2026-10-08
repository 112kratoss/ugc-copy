# Section 12F — bounded referral settlement progress

Status: reproduced against the actual local reconciliation service and SQL;
candidate passes local regression, clean replay and permission checks. Candidate
CI, standard production release and independent live verification remain pending.

The bounded settlement selector always chose the oldest 100 transactions without
recording failed attempts. A full batch of persistent failures therefore prevented
healthy later purchases from ever reaching settlement. A local fixture puts one
inviter at the integer credit ceiling, creates 100 older purchases for that
inviter, and places a healthy purchase for a different inviter afterward. Two
actual service passes each processed and failed the same 100 purchases with
`integer out of range`; the healthy purchase had no settlement event. Cleanup
independently confirmed zero fixture users, transactions and programs.

## Candidate change

A private retry table records per-purchase attempts and the next eligible time.
The guarded service RPC locks the original transaction and rechecks whether
settlement already committed before deferring. Backoff starts at one minute,
doubles to a one-hour cap, and keeps failed work recoverable. Purchase timestamps
and financial history are not changed to rotate the queue.

The existing selector excludes deferred rows until they become due, preserving
its detached-account matching and batch bound. Eligible work is ordered by its
last attempt (or original transaction update when never attempted), so failures
move behind older waiting work even when the hourly job runs after backoff
expires. An expanded candidate test reproduced this cadence gap in a backoff-only
version; both immediate and overdue retry cases pass after the ordering change. A successful settlement clears
retry metadata with an event-insert trigger in the same financial transaction,
including foreground settlement outside the reconciliation job. Lost settlement
acknowledgements therefore cannot recreate completed work. Notification-only
failures continue through the separate 12B notification queue. Deferral-write
failures remain visible as job failures rather than being reported as success.

Clients have no table or RPC access. The service role can inspect retry state and
invoke guarded deferral, but cannot directly insert/update/delete retry rows or
invoke the cleanup trigger. Both new functions use qualified definer access.

## Local evidence

- The before-fix service/SQL reproduction fails at healthy-purchase progress.
  After the fix, the first pass defers 100 failures and the second settles the
  healthy purchase both immediately and when all failed rows are already due. Removing the local fault and making retries due recovers all
  100 purchases, with exactly 101 total purchase events and the expected inviter
  balance. Both regressions verify increasing/capped retry delays, attempt
  counter saturation, foreground cleanup and stale acknowledgement handling.
- Nine focused cases pass, including explicit deferral-write failure and the
  distinction between settlement and notification failure.
- All 18 existing notification recovery cases and 16 account-deletion lifecycle
  cases pass with actual local PostgREST/SQL.
- Clean migration replay and 2,340 SQL assertions across 109 files pass. Twelve
  new assertions cover RLS, role grants, trigger execution restrictions and
  missing-transaction handling. App/test typechecking and scoped lint pass.

This is a queue-progress fix, not a claim that real accounts reached the integer
ceiling or that all jobs are certified. No production customer balance has been
changed. Full lease fencing, real provider delivery and other PAY-04/JOB-02
obligations remain open. Production inventory and release checks are still due.

Private before/after, cleanup, replay and regression evidence is under
`.audit-evidence/backend-social/referral-settlement-progress-*`.
