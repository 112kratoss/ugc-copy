# Section 5B — refund/dispute production verification

PR [#233](https://github.com/112kratoss/ugc-copy/pull/233) merged as
`663d7690b52a2d6bb384c5e04cf8ef3affee7143`.

- PR Quality [36343971292](https://github.com/112kratoss/ugc-copy/actions/runs/36343971292): all four jobs passed, including the real handler/database regression suite.
- Exact-main Quality [36369678170](https://github.com/112kratoss/ugc-copy/actions/runs/36369678170): all four jobs passed.
- Production [36370206715](https://github.com/112kratoss/ugc-copy/actions/runs/36370206715): successful at 2026-09-28 02:36:09 UTC, including staged checks, promotion and live health. Independent `/api/app-version` matched the merged commit.

The deployed `reconcile_razorpay_credit_source` definition matches the local
replay digest `e82e038e19e2a8461f53015dae472974`. Production records migration
`serialize_razorpay_credit_adjustments` under Management API-generated version
`20260928023255`; repository version is `20260927191224`. The release runner
supports this translation through unambiguous migration-name matching.

**52 production SQL assertions passed** using
`scripts/ops/verify-razorpay-credit-sources.sql`, including partial refunds,
dispute ordering, immutable won state, replay, caps, spent-credit debt,
refund-before-grant, invalid evidence, legacy-state detection and access control.
All fixture transitions ran inside one transaction that rolled back. Independent
queries returned zero fixture users, profiles, transactions, immutable adjustment
rows and new source rows. No customer balances or provider payments were changed.

**18 live HTTP checks passed** at 2026-09-28T02:36:46.163Z using
`scripts/ops/verify-payment-webhook-admission.mjs`. These are credential rejection,
body-limit, signed-out checkout and missing-evidence checks with no-store headers.
Successful provider event delivery and real payment/refund processing were not
exercised in production; actual handler + database behavior is covered by CI,
and production SQL behavior by the rollback probe.

Schema verification confirmed the expected new table, indexes, constraints,
service-only RPC grant and service read-only source-table grant. Existing
policies, triggers, views, sequences, extensions and storage fingerprints stayed
unchanged. Counts are now 131 public tables and 307 public functions. Function
class digest is `5d861b25d2fdfec07fdda956401298a5`.

Local/production parity was checked by class. Differences outside the new objects
were column order, local pgTAP, and two unrelated function body texts. Inspection
showed omitted explanatory comments in `finish_generation_completion_job` and
inferred rather than explicit empty `uuid[]` casts in `apply_admin_post_moderation`.
The new function body, columns, constraints, indexes and grants match the replay.
This report does not claim all existing schema representations are identical.

Security advisor groups remain 1 INFO, 37 WARN, 0 ERROR. The new source table
appears in the informational [RLS enabled without policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
notice, as intended for a table with no client access and privileged RPC writes.
The warning backlog remains outside this batch; unchanged group counts do not
mean an empty security backlog.

Local evidence: 258 cleanly replayed migrations; 82 SQL files / 1,735 assertions;
139 focused unit tests; four real handler/database regressions. Independent local
connections also passed 40 competing opens followed by 41 mixed won/open/refund
calls. All local stress fixtures were removed by resetting the dedicated audit DB.

The preceding [batch report](backend-section-05-refund-ordering-2026-09-28.md)
contains the reproduced balances, design and legacy/rollback handling. Remaining
batches include commerce entitlement/creator-ledger settlement, RevenueCat,
referral policy behavior and provider-backed sandbox delivery.
