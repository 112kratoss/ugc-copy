# Section 4 — payout state transitions

Status: null-action defect fixed and deployed in PR #229. Production verification
passed 36 SQL assertions and 17 HTTP checks; see
backend-section-04-payouts-release-2026-09-27.md for exact-build evidence.
This batch covers payout requests, holds, resolution/replay and detached records.
Purchase settlement, provider signatures and broader refund/ledger workflows
remain separate batches.

## Finding

`resolve_creator_payout_request` checked `p_action NOT IN ('mark_paid','reject')`.
For SQL NULL that expression is NULL, so the guard did not run. Later branches
fell through to rejection, releasing the hold without a rejection reason.
The RPC is service-role-only and the current admin HTTP handler independently
rejects a null action. This is a privileged database contract defect; the audit
did not establish an ordinary-user exploit or an HTTP validation bypass.

Six of 36 local state-machine assertions failed before the fix. A rolled-back
production transaction reproduced a 1,500,000-subunit hold returning to the
fixture's available balance after a null action. No real transfer occurred and
no fixture financial record was committed. Independent user/wallet/request
counts were zero afterward. An aggregate query found zero existing rejected
requests with a null resolution note; that is a narrow check, not an incident
attribution or exhaustive historical proof.

Migration `20260927174233_reject_null_payout_resolution_action.sql` explicitly
rejects null before taking a row lock or mutating state. It preserves the
function signature, grants and valid-action accounting. No client change or
mobile release is required.

## Validation

- **36 database assertions** cover minimum/exact-minimum amounts, whole-balance
  holds, duplicate requests, null/unknown actions, required rejection reasons,
  both successful decisions, conflicting replays, earnings arriving during a
  hold, debt preserved on rejection, account-deletion retention, detached
  settlement and denied anonymous/authenticated RPC execution.
- Clean replay completed **256 migrations**; **80 files / 1,646 assertions** passed.
- **34 focused application tests** passed across four files for payout services,
  operator mapping, encrypted details and the existing migration contract.
- Local concurrency: 20 requests admitted exactly one; 20 mixed pay/reject
  decisions completed exactly one, with 19 already-resolved responses. Final
  available/held/paid totals matched the winning decision. Isolated fixtures
  were removed.
- `scripts/ops/verify-payout-state-machine.sql` repeats the matrix using temporary
  invoker assertions in one rolled-back transaction. Fixture triggers were
  reviewed; financial transitions call no external payment provider.
- `scripts/ops/verify-payout-admission.mjs` exercises real client/guest sessions,
  service-only RPC denial, payout HTTP validation, below-minimum rejection,
  admin denial and revoked-session denial with zero-balance fixture accounts.
  It refuses to delete identities if unexpected financial records exist.

## Boundaries and remaining work

Production successful transitions are tested only inside a transaction that
rolls back. Tests prove stored accounting and permissions, not an external bank
transfer. Detached obligations deliberately remain settleable without a live
wallet, matching the existing retention contract. Successful operator-cookie
HTTP settlement and provider transfer reconciliation are not certified here.

The manual payout rail records an operator's decision after an external
transfer. Razorpay/RevenueCat settlement, webhook replay, purchase refunds and
wallet earning/reversal triggers still need their own audit evidence.
