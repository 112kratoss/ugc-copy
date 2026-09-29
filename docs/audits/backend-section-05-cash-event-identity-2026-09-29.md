# Backend Section 5H — cash refund event identity

Baseline: `8db0efbde28ce23414ed8e6e51001a4d1e9ef6d2`. Audit checkout reused with
all local evidence preserved; branch `codex/payment-event-identity`.

## Confirmed finding

The marketplace and post-resource cash adjustment RPCs checked for an existing
event or payment/action, then returned `already_adjusted` (or `manual_review`)
without validating the incoming payment, action or provider order. They also
matched an event belonging to the other purchase kind. The Razorpay dispatcher
tries marketplace before bundles, so bundle replays could terminate before their
own order identity was checked.

Reusing a refund event with conflicting identity was therefore acknowledged as
processed even though the requested adjustment had not happened. This is a
service/provider-input consistency defect, not evidence that an unauthenticated
caller can forge Razorpay webhooks or that a provider has sent conflicting events.
No affected live customer was found: production cash adjustments, credit
adjustments and Razorpay adjustment-source ledgers were all empty at preflight.

Local real-Postgres regression: ten new cases failed on the baseline (changed
payment/action/order, conflicting order on a semantic duplicate, and wrong-kind
fallthrough); two matching-identity controls passed. The webhook unit regression
also failed: a conflict response was acknowledged as HTTP 200 instead of retried.

A production rollback probe independently reproduced eight incorrect duplicate
responses out of eleven checks. It inserted only two isolated cash-ledger fixture
rows with no customer/order references, used `service_role`, 3-second lock and
15-second statement limits, then rolled back. Separate cleanup found zero fixture
rows. No customer balances, provider purchases or refunds were changed.

## Change

Migration `20260929142945_validate_cash_adjustment_event_identity.sql` patches
exactly one duplicate branch in each existing function, preserving the current
locks, order/entitlement transitions, wallet logic, security-definer search path
and service-only grants:

- A duplicate must have the same payment and action; otherwise `event_conflict`.
- A matching event on the other purchase kind returns `not_found`, allowing the
  dispatcher to reach that purchase's handler.
- A supplied provider order must match the ledger's referenced order, including
  semantic duplicates under a different event ID; otherwise `order_conflict`.
- Valid replays retain their existing acknowledgment and do not change state.

The HTTP handler treats `event_conflict` as unresolved, records existing durable
failure telemetry, and returns HTTP 500 so it is not silently acknowledged. A
permanent provider inconsistency needs operator investigation; retry alone does
not repair its identity.

## Verification and release requirements

- Pinned CLI 2.75.0 created the migration. Clean isolated database reset passed.
- Full pgTAP suite: 1,872 assertions in 87 files passed (12 added identity cases).
- Focused webhook/migration tests: 31 passed; test typecheck and targeted lint passed.
- Full web suite: 6,128 passed (41 database-only cases run separately in CI).
- Existing cash-concurrency and Razorpay/database suites passed (7 cases).
- The actual release migration planner against the complete production ledger
  found exactly this one pending migration, no out-of-order file, and latest
  applied repository version `20260929120001`.
- Pre-release security advisors retain 1 INFO / 37 WARN / 0 ERROR. Schema
  fingerprints and probe evidence are saved under `.audit-evidence/backend-section-05h/`.

Deploy only through exact-main Quality and `production-release.yml`. Repeat the
bounded rollback probe after release; expect 11/11 checks and zero residual
fixtures. Compare schema classes and advisors; only functions should change.

## Remaining audit scope

This batch covers cash marketplace/bundle replay binding. It does not certify
every cross-rail path. The shared credit adjustment ledger's provider/event
duplicate check and RevenueCat wrapper status propagation still require real
database reproduction: inspect whether one event reused on another credit
transaction can advance mobile event state without reversing its balance.
Provider namespaces, non-credit mobile event binding, marketplace concurrency,
reporting double-count prevention and real provider-backed delivery remain
separate follow-ups. No overall audit coverage percentage is claimed.

Section 5G release evidence and the existing Section 1 files are preserved.
