# Section 12B — referral notification recovery

Status: reproduced locally; candidate implementation passes focused and actual
database/HTTP recovery checks. Candidate CI and standard release remain required.

Two actual PostgREST/SQL cases fail before the fix: a committed reward settlement
whose reply is lost, and a notification insert rejected after reward settlement.
Both correctly credit inviter and invitee once, but leave no notification after
the reconciliation job retries. Its unsettled-purchase selector excludes the
already committed purchase, while the notification helper swallows insert errors.
Two normal/deduplication controls pass on the same baseline. The first attempt
could not connect because Docker was stopped; that is retained as infrastructure
evidence, not a reproduced application failure. Docker was started and the same
isolated audit stack resumed without a reset of the primary database.

## Change

The CLI-created migration `20261007150522_referral_reward_notification_outbox.sql`
adds a private queue populated by a trigger in the same transaction as each new
referral ledger event. It queues grants, reversals and restorations. Delivery
locks at most 100 due entries with SKIP LOCKED, creates notification history and
zero-attempt push work, and marks completion in one transaction. A poison entry
backs off without rolling back other entries. Notifications use immutable ledger
identity and amounts; caller-supplied credit/user/reward fields do not mint or
redirect a notification. Foreground referral notification requests use the same
RPC, scoped to the financial event key. The existing push worker checks current
preferences/token ownership and spends an attempt before provider I/O.

The reconciliation job checks due notification work even after all purchases
have settled. Partial notification/settlement failures fail the managed job
with a persisted summary. Completed queue entries prevent recreation after
notification retention. No historical financial events are backfilled: retention
cannot establish which older notifications were delivered. A fresh read-only
production inventory contains zero referral ledger entries, rewards or settled
referral purchases; no historical customer repair is needed for this finding.
The earlier promotional-only admin adjustment remains a separate PAY-04 review.

Normal referral history remains available after the foreground RPC completes.
Push transport is now queued for the existing ten-minute maintenance cadence;
the hourly referral job supplies recovery after foreground interruption. This
changes referral push timing and does not change credit settlement or other
notification types. No provider credentials or real push device is used in tests.

## Evidence and limits

- **18 actual local controls** pass: the two reproduced failures, normal/replay,
  committed notification reply loss, queue-only eligibility, rollback atomicity,
  targeted authoritative identity, reversal/restoration, eight concurrent drains,
  bounded batches/retention, poison-event failure and managed summary, completion
  marker failure, anonymous/authenticated denial, enabled/disabled device behavior
  through a local HTTP provider, and two real Node SIGKILL checkpoints.
- The expanded focused suite passes **151 tests** across seven files. Notification
  timing fixtures now emulate the new RPC boundary; the actual database/HTTP cases
  establish its implementation behavior. Earlier fixture failures are retained.
- The full local web run passed 7,495 cases and found two outdated checks: the
  cron mock omitted the new error class and the deep-link inventory expected the
  referral link in TypeScript after its move to SQL. Both are corrected with
  explicit SQL-link contract coverage and managed failure-summary coverage; the
  focused repair suite passes 11 cases. Exact candidate CI will rerun the full suite.
- Clean isolated migration replay passes. All **2,316 SQL assertions in 107 files**
  pass, including new queue/grant/batch controls. App/test types, scoped lint and
  diff checks pass after correcting the test worker's NODE_ENV declaration.
- Production migration planning against the complete ledger identifies only this
  migration as pending, with no out-of-order migration. No production DDL ran.
- Owned Auth/profile/transaction/referral/notification/queue fixtures are removed.
  The local append-only financial-fixture cleanup uses exact IDs in a privileged
  transaction; it is never a production cleanup procedure.

Raw logs and read-only baselines remain private in
`.audit-evidence/backend-social/referral-*`. PAY-04 and JOB-02 remain open for
release verification and broader lifecycle/progress evidence. No genuine Expo,
RevenueCat, store purchase/refund, or installed-client delivery is certified.
