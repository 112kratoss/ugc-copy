# Section 11G — independently verified wallet aggregate release

[PR #385](https://github.com/112kratoss/ugc-copy/pull/385) passed all five Quality
jobs in `37523837244` at exact head
`476b2463f15b8905ea52a90a0f16045b344d1195`. The independently verified mobile
#384 parent was incorporated and preserved; an immediate mobile-store idle
check preceded the October 6 20:19:39 UTC merge as
`c3995ddc8e5ca1b29fb7a777e62300e844043900`.

Exact-main Quality `37525598535` and standard release `37526868504` pass.
Independent checks at October 6 20:34:11 UTC confirm the exact live build and
`ugc-app` project. Only the new function and its execute grant change the public
schema; every existing function definition and privilege remains unchanged.

`admin_creator_wallet_totals()` matches clean replay digest
`cd2b014a27e6b7276f75a26805730069`: STABLE, fixed definer search path and service-only
execution. A bounded production rollback probe verifies three additional wallets
with positive, negative and zero available balances, complete count and signed
totals. Independent readback finds zero Auth/profile/wallet fixtures. All 110
security advisor findings are unchanged. Live feed, admin redirect and unsigned
webhook smoke return 200, 307 and 401.

Source migration `20261006193446` maps to production ledger version
`20261006203018`, name `admin_creator_wallet_totals`; the mapping was independently
read back without repair. The [before/after report](backend-section-11-admin-wallet-totals-2026-10-07.md)
retains the real PostgREST ceiling reproduction and local test scope.

This verifies the wallet fix. OPS-04 remains failed for the pending user-detail,
health-disclosure and broader method/collector obligations. The full audit remains open.
