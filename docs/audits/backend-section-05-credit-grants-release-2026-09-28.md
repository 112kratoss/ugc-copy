# Section 5A — credit grant production verification

PR [#231](https://github.com/112kratoss/ugc-copy/pull/231) merged as
`015fd701470b3858aa7a15933bc54fe4f6a4f2e1`.

- PR Quality [36341906701](https://github.com/112kratoss/ugc-copy/actions/runs/36341906701): all four jobs passed.
- Exact-main Quality [36342535896](https://github.com/112kratoss/ugc-copy/actions/runs/36342535896): all four jobs passed.
- Production [36342979750](https://github.com/112kratoss/ugc-copy/actions/runs/36342979750): successful at 2026-09-27 19:07:25 UTC, including staged checks, promotion and live health. Independent `/api/app-version` returned the exact merged commit.

Production `add_credits` matched the locally replayed function digest
`ae35d0411d87583930a103c45393e72e`. The migration is recorded under the
Management API-generated version `20260927190439`, name
`require_credit_grant_payment_evidence`; repository version is `20260927184203`.
The release runner's unique-name matching explicitly supports this timestamp
translation. This is not a claim that ledger version numbers equal filenames.

All **37 SQL assertions** passed against the deployed production function via
`scripts/ops/verify-credit-grant-evidence.sql`. The test creates temporary
invoker assertion helpers, exercises successful/invalid grants and full refund
on isolated fixtures, and rolls the entire transaction back. Independent
queries returned zero fixture users, profiles, transactions and adjustment
rows. No real account balances, provider charges or bank transfers were changed.

After promotion, **18 HTTP checks** passed at 2026-09-27T19:08:15.458Z using
`scripts/ops/verify-payment-webhook-admission.mjs`. These validate webhook
credential rejection, body limits, signed-out checkout and missing verification
evidence, with no-store responses. They do not prove a successful provider
purchase or actual webhook delivery.

Schema fingerprints: 15 of 16 object classes unchanged; only function definitions
changed, with 306 functions before/after. Function-class digest changed from
`213d008371cdd6167783973de3496a81` to
`0bc46ec0c409d73f28e62c4c4fdbd7e3`. Tables, constraints, indexes, policies,
triggers, grants and storage classes were unchanged. Security advisor counts
remained 1 INFO, 37 WARN, 0 ERROR; existing notices remain outside this batch.

Local release evidence: 257 cleanly replayed migrations; 81 SQL test files /
1,683 assertions; 22 focused Vitest files / 135 tests. Concurrent SQL tests
confirmed one grant per transaction/payment and a correct capture/refund race.
See [the batch report](backend-section-05-credit-grants-2026-09-28.md) for the
reproduction, scope and remaining Section 5 work.
