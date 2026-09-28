# Backend audit section 5C — marketplace quotes and paid access

Date: 2026-09-28. Status: deployed and production-verified through PR #236, live commit `bd0f983e18b13990b0fbd9355ab6b89b259119c4`. See [release evidence](backend-section-05-commerce-release-2026-09-28.md).

## Reproduced defect and repair

A cash marketplace checkout did not persist the USD-cent listing quote. `complete_marketplace_purchase` loaded the current asset price at capture and used it for both the purchase ledger and gross earnings. The creator wallet trigger then credited 85% of that mutable price. In a real local database, a 300-cent checkout followed by a listing change to 1,000 cents settled at 1,000 cents and credited 85,000 wallet subunits instead of 25,500. Three SQL assertions failed before repair; the route service also failed a test requiring the original quote on the order.

The server now includes its USD quote in the checkout intent hash, provider notes and order row. Replay and insert-conflict recovery must match it. A new immutable, positive `quoted_price_usd_cents` column supplies cash settlement. The payment amount and currency checks remain in the verification/webhook services; the quote is never supplied by the buyer. Free and mobile settlement use their existing separate RPCs.

Historical rows are intentionally not backfilled from today's listing. A cash order without a quote stays created, grants nothing and causes the existing webhook unresolved-order path to request retry/operator review. The production preflight found zero created and zero paid marketplace orders. A request served by the old app between migration and promotion can still create a missing-quote order; check for those after release. Rolling the app back to a version that omits the quote requires reviewing those orders before resuming checkout. Never invent an old quote from a current listing.

## Coverage in this pass

| Boundary | Evidence |
| --- | --- |
| Cash quote increase/decrease, including listing becoming free | New real-DB settlement assertions; original defect reproduced before patch |
| Ledger and wallet split | Original quote, 85% creator / 15% platform, duplicate capture, refund, duplicate refund |
| Order integrity | Missing quote fails closed; quote updates and zero quotes rejected; RPC restricted to service role; clients cannot update orders |
| Checkout recovery | Service tests cover matching/conflicting quotes on replay and unique-insert races |
| Bundle cash settlement/refunds | Existing real-DB cash reconciliation, revision and wallet suites rerun from clean migration replay |
| Paid resource payloads | Existing service tests cover owner/buyer/nonbuyer, locked prompts and references, purchased revisions, deleted/delisted content and moderation takedowns |
| Download signing | Existing service tests require entitlement, resource membership and canonical owner-scoped paths; purchased revisions remain downloadable |
| Mobile/free purchases | Existing DB suites rerun; no changes to their RPCs or clients |

The bundle completion function already uses its immutable quoted revision and price. The bundle earnings projection is maintained by its existing economics trigger; it is not independently incremented money. Marketplace gross earnings remain a gross projection; the creator wallet ledger remains the money of record.

## Validation

- Fresh replay of all 260 migrations succeeded on the isolated local database.
- All 84 pgTAP files passed: 1,781 assertions, including 26 new quote/ledger/access checks.
- All 61 focused marketplace, post-resource and webhook test files passed: 411 tests.
- The production probe `scripts/ops/verify-marketplace-cash-quotes.sql` passed locally under service-role permissions. It runs fixture-only transitions inside a rollback transaction, with temporary invoker assertions and bounded lock/statement timeouts.
- App/test typechecks and targeted lint passed.
- PR Quality [36379261246](https://github.com/112kratoss/ugc-copy/actions/runs/36379261246): all four jobs passed. Web: 6,012 tests; mobile: 2,738; browser: 18; database: 1,781 assertions plus 2 credit concurrency tests and 4 real-handler/database tests.
- Production pre-release financial ownership probe passed 48 rollback-only assertions, with zero remaining fixtures; eight commerce endpoints passed 16 invalid-auth/no-store HTTP checks.
- Exact-main Quality [36379991804](https://github.com/112kratoss/ugc-copy/actions/runs/36379991804) passed; production release [36380693661](https://github.com/112kratoss/ugc-copy/actions/runs/36380693661) succeeded.

## Limits and remaining work

This certifies the covered contracts, not every backend path. No real provider payment, refund, payout or customer-balance mutation was initiated. Test fixtures exercise actual SQL; most app access checks use service mocks, so they do not prove a fresh hosted browser purchase/download flow. Previously issued signed download URLs expire after 600 seconds; removing an entitlement prevents issuing another URL but does not revoke an already signed URL immediately.

Commerce dispute restoration remains an explicit manual-review policy. Broader cross-rail event identity conflicts, simultaneous bundle capture/refund lock ordering and the full mobile store lifecycle remain follow-up audit areas; no speculative patches are included for them.
