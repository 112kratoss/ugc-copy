# Section 11G — complete creator wallet reporting

The revenue collector's `.limit(5000)` still receives at most 1,000 wallet rows
from the actual Data API. A regression with 1,001 valid local wallets reports
1,000 wallets, 1,000 available token subunits and 1,000 lifetime earned subunits
instead of 1,001 for each. This reproduces against real PostgREST and Postgres;
it is a reporting defect, not a payment or wallet mutation.

The collector now reads `admin_creator_wallet_totals()`, which returns the
complete count and both sums in one stable SQL snapshot. The function executes
only for `service_role`, fixes its definer search path, and coalesces empty sums
to zero. Negative available balances remain part of the aggregate. The UTC
CLI-stamped source migration is `20261006193446_admin_creator_wallet_totals.sql`.
The standard release must install the function before deploying its caller.

All 24 actual API/SQL collector cases pass, including the 1,001-wallet regression,
anonymous RPC denial and an injected RPC 503 that rejects the report rather than
displaying zero money. The existing 50 focused collector cases and two new
migration guards pass; app/test type checks and scoped lint pass. A clean replay
includes the new migration, and all 2,185 assertions in 102 pgTAP files pass.
Eleven wallet SQL assertions cover privileges, denied execution, empty totals,
zero/negative balances and authorized execution.

The first SQL test run stopped after nine assertions because three fixture UUIDs
shared the prefix used by the real Auth trigger for default usernames. Distinct
prefixes correct the fixture; neither the trigger nor its uniqueness constraint
was changed. The full SQL suite subsequently passes.

The API fixture identities exist only to satisfy wallet foreign keys. No sessions,
purchase, settlement, provider request or customer balance was created or changed.
Cleanup independently reads back zero tracked wallets, Auth users and profiles.
Only the new function was installed in the owned API fixture; its migration ledger
was not repaired. The complete replay independently validates the source migration.

A private read-only production aggregate at October 6 19:37:07 UTC finds one
wallet, below the reproduced ceiling. No current production undercount or
incorrect customer balance is attributed. Evidence is retained privately under
`.audit-evidence/backend-social/admin-wallet-*`.

Exact-head Quality, the independently verified #382 parent release, standard
deployment and independent function/grant/rollback fixture checks remain required.
OPS-04 remains failed pending this fix and its broader behavior matrix. The
ledger remains 53 obligations: 24 passed, 25 untested, two failed, two external.
