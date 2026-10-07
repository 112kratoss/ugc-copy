# Section 11Y — admin adjustments and total spendable credits

Three actual native-handler/Auth/admin-session/PostgREST/SQL cases reproduce
incorrect spendable balances. Goodwill from 500/0 produces 500/7 instead of
507/7. Clawback from 507/7 produces 507/0 instead of 500/0; clawback after spend
from 3/0 produces 3/-7 instead of -4/-7. The purchased restoration control passes.
Four focused policy/RPC assertions also fail before the fix. Evidence is in
`.audit-evidence/backend-social/admin-credit-balances-before.log` and
`admin-credit-policy-before.log`. All baseline fixtures are removed.

`profiles.credits` is the total spendable balance and promotional credits are a
subset, as already implemented by welcome/referral grants and spend paths. The
admin policy incorrectly treated them as independent purchased/promotional
balances. Goodwill and clawback now change total and promotional credits by the
same signed amount; purchased restoration changes total only. The admin preview
and server share a pure policy module, and the confirmation labels the total
correctly. Existing limits, reviewer identity, required reason, row locking,
idempotency, SQL permissions and negative debt behavior are retained.
No migration, provider payment, mobile runtime or price change is included.

All **42 actual cases pass**: the 37 input/session/onboarding controls from 11X,
four balance/replay controls including spent-credit debt, and eight concurrent
grants followed by eight concurrent reversals. The original valid adjustment
case now checks the correct total, session reviewer, audit deltas, replay and
route-based reversal. The standalone balance controls capture actual SQL state
before resetting only their disposable fixture balance. Exact-ID queries verify
zero owned rows afterward; no grants/fingerprints or AI usage are created.
See `admin-credit-balances-concurrent-corrected.log`.

All **50 focused cases** pass across policy, onboarding, migration, admin page,
mobile contract and three component confirmation controls. Component controls
check the visible resulting totals, promotional subset and debt warning without
sending a request; they are jsdom evidence, not a hosted-browser claim. App/test
types, scoped lint and diff checks pass. A local concurrent-test syntax error
prevented test import before any fixture use and was corrected; a component-test
query option was corrected after test typechecking. Original logs are retained.
Exact candidate/main Quality, standard release and independent source/schema/
live verification remain required. PAY-04 records this finding until release;
the broader financial lifecycle obligation stays open.

A bounded read-only production inventory finds **three** historical adjustment
rows: one positive promotional-only row and two purchased-only rows. The positive
row predates this audit and cannot be attributed to this route or identified as
an audit fixture from these aggregates. Its intent, subsequent activity and any
repair need operator review; no historical balance or ledger was changed and no
automatic compensating grant is included. The prevention fix does not establish
historical reconciliation or genuine provider delivery. Private evidence:
`admin-credit-balances-production-inventory.json` and
`admin-credit-balances-historical-review.json`.
