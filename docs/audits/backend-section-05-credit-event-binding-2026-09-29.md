# Backend Section 5I — shared credit event binding

Status: reproduced and fixed locally; release verification pending.

A RevenueCat refund event reused for another credit receipt was acknowledged as
`already_refunded`: the second receipt became revoked and its transaction consumed
the event, while its credits remained spendable. Reusing a refund event as a
refund reversal was also acknowledged as a duplicate. The shared credit RPC
checked only provider/event existence, and the mobile wrappers skipped financial
identity checks or translated unresolved outcomes into success.

The shared credit ledger now binds an event to its original transaction and
reversal target. Conflicts return `event_conflict`. Mobile credit adjustments
validate through that ledger, and both mobile wrappers propagate unresolved or
duplicate outcomes without consuming event metadata or changing receipt state.
The Razorpay wrapper also returns unresolved results before binding a payment.
The HTTP adapter returns 503 and durable failure telemetry for unresolved and
unknown adjustment statuses. Existing permanent `identity_mismatch` handling is
unchanged; this batch does not resolve account-transfer policy.

Migration: `20260929150256_bind_credit_adjustment_events.sql`, created with the
pinned Supabase CLI. Six guarded replacements update four existing functions;
locks, monetary calculations, history and service-only grants are preserved.
No tables, customer balances or historical adjustments are repaired.

## Reproduction and validation

- Five initial real-Postgres assertions failed against the original SQL.
  A sixth regression reproduced conflicting input hiding behind stale snapshot
  handling; event identity is now checked before cumulative-state ordering.
- Four database-backed HTTP regression cases failed against the original SQL:
  reused receipt events and changed-action replays, for both Apple and Google.
  The corrected fixtures use the parser's `REFUND_REVERSED` event. An initial
  fixture used ignored `UNCANCELLATION`; it was corrected and the baseline rerun.
- Six adapter cases failed before the HTTP fix, covering unresolved and unknown
  outcomes. These are injected handler inputs, not actual provider deliveries.
- Bounded production rollback probe: four incorrect outcomes among eleven
  checks. The conflicting receipt was marked revoked and consumed the event,
  confirming the source-level finding. Separate cleanup found no fixture user,
  transactions or receipts. No real customer data was changed.
- Clean migration replay and all 1,885 pgTAP assertions in 88 files passed.
- All 34 focused adapter/migration/database cases passed, including valid
  duplicates, independent refunds, restores, and delayed stale events.
- Full web suite: 6,135 passed, with 45 database cases skipped and exercised
  separately as appropriate by focused tests and Quality.
- Test typecheck, targeted lint and diff checks passed. The production ledger
  planner finds exactly one correctly ordered pending migration.

Private evidence is in `.audit-evidence/backend-section-05i/`. The production
probe and tests use synthetic receipts; this does not certify provider-backed
purchase/refund delivery. Noncredit mobile event binding, marketplace concurrency,
reporting and a measured audit coverage tracker remain separate follow-ups.
