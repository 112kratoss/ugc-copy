# Backend Section 5J — noncredit mobile event identity

Status: deployed and verified on `041ff8a5cf3280c7438285e6eb4fd33cc615490f`.
See [release evidence](backend-section-05-mobile-event-history-release-2026-09-29.md).

The mobile adjustment RPC remembered only each receipt's most recent event.
Reusing a marketplace or legacy bundle event for another receipt could revoke
that receipt, including a credit receipt. Changing the action or timestamp of
the latest event was acknowledged as a duplicate. After a restore, an older
refund event resent with a newer timestamp could revoke restored access again.

`20260929163206_retain_mobile_adjustment_event_identity.sql` adds private event
history keyed by RevenueCat event ID, binding each successfully processed event
to its immutable receipt, action and provider timestamp. An advisory lock on the
event is acquired before receipt locks, so concurrent deliveries cannot assign
one event to different receipts. Conflicts return `event_conflict`, which the
already-deployed HTTP adapter reports as retryable 503 with durable telemetry.

The common mobile adjustment RPC records successful credit and noncredit
adjustments atomically with their effects. It checks historical credit-ledger
events too, preventing their reuse for noncredit receipts. Duplicate and stale
deliveries remain harmless; failed restores and missing purchases do not reserve
an event. The service role can read history but cannot directly insert, update,
delete or truncate it; clients have no access. History references the retained,
anonymized receipt rather than storing a new user-identity link.

The migration preserves existing latest-event snapshots. Duplicate legacy event
IDs or incomplete timestamps fail migration rather than selecting an arbitrary
owner. Earlier noncredit events were overwritten and cannot be reconstructed.
Pre-release production inventory contained eight credit receipts and no noncredit
receipts or processed-event snapshots, so no historical repair is needed.

## Evidence

- Fifteen of 28 new real-Postgres identity checks failed against the original
  function; all pass with the fix. Coverage includes marketplace and legacy
  bundles, action/timestamp changes, reused historical events and credit/noncredit
  collisions. Local legacy-bundle fixtures temporarily disable only the insert
  policy trigger, then re-enable it before reconciliation. New mobile bundle IAPs
  remain blocked. Production probes do not disable triggers or exercise bundles.
- Three true concurrency cases pass: same receipt, different receipts, and
  conflicting actions. Each checks one retained event plus receipt, entitlement
  and creator-wallet consistency. Added to Quality's database job.
- Eighteen focused migration/concurrency/receipt tests pass; all 1,922 pgTAP
  assertions in 89 files pass. Clean migration replay, test typecheck, targeted
  lint and diff check pass.
- Local backfill probe applied the migration over a pre-migration refund and
  verified retained action/time, duplicate replay and cross-receipt rejection.
- Bounded production rollback probe reproduced seven incorrect outcomes among
  fourteen checks. Separate cleanup found zero fixture users, receipts, products
  or credit adjustments. No customer balances or provider charges were changed.
- Full web suite: 6,136 passed; 48 database cases skipped by that invocation
  and covered separately through the database workflow.
- Production migration planner found exactly one correctly ordered migration.
- Exact-main Quality and the standard production release passed. All 14
  production rollback checks pass after deployment, with zero residual fixtures;
  deployed function digest matches local replay. See the release report for
  schema, advisor and live endpoint checks.

Private evidence is under `.audit-evidence/backend-section-05j/`. This certifies
synthetic RPC behavior, not real provider delivery. Marketplace lifecycle and
concurrency outside event identity, legacy bundle restoration ownership,
reporting, and measured overall audit coverage remain follow-ups.
