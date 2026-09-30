# Section 5L — retained payout reporting and watchdog diagnosis

Date: 2026-09-30. Base: `b04ccb46cfecb042b8215e521e0633bc44b9cdf9`.
Status: deployed and verified in PR #247 on main `65890e3146309b5e62fac155f72983de4475a7a1`.
Production release `36672523382` succeeded 2026-09-30 05:18:19 UTC. See the
companion release report for exact-main CI and live checks.

## Retained payouts poison mixed creator lookups

Payout requests intentionally survive account deletion: `user_id` becomes NULL,
while `detached_user_id` retains the reconciliation identity. Both admin queue
collectors included the missing live identity in UUID filters. The history
collector converted it to the string `"null"`. PostgREST rejects either filter
with HTTP 400 / SQLSTATE 22P02. Because enrichment errors were ignored, one
retained request also removed names and lifetime earnings for active creators on
that page. Deleted creators appeared with zero earnings and history linked to
`/admin/users/null`; the retained identity was not shown.

Reproduction, before implementation:

- A bounded read-only production profiles lookup with `in.(null,<zero UUID>)`
  returned 400 / 22P02. Removing null returned 200. No fixture or customer state
  was written.
- Three service regressions failed against the original code: mixed open queue,
  mixed resolved history, and a queue containing only deleted accounts.
- Chromium rendered the actual local Next.js `/admin/payouts` route, including
  its admin session checks, against an isolated HTTP fixture backend. A mixed
  page lost the active creator's name and $200 lifetime earnings, displayed
  `$0.00`, and linked the deleted creator to `/admin/users/null`.

The fix selects the already-retained identity, represents a missing live user
as null, and enriches only live user IDs. A detached-only page skips enrichment.
The page labels deleted creators, displays their retained reconciliation ID,
shows lifetime earnings as unavailable after deletion, and omits their profile
link. Existing payout actions still address the request ID. Settlement RPCs,
balances and external transfer behavior are unchanged; no migration is needed.

Verification:

- 15 focused tests passed, including the three reproduced service failures and
  a history rendering regression.
- App and test TypeScript checks and targeted ESLint passed.
- Chromium after the fix showed `Active Maker`, `$200.00`, a deleted-creator
  label, the full retained ID, unavailable earnings and no null profile link.
  This is a real browser/local route check with fixture data, not a live payout
  or external transfer certification.
- Production payout inventory currently contains zero rows. No customer data
  repair is required; this is prevention for the supported deletion lifecycle.

## Watchdog 503 is explained by overdue moderation

GitHub watchdog run `36656295878` failed with HTTP 503 before Section 5K's
release, while the protected release health checks passed. A read-only execution
of the current alert collectors against production at 04:47 UTC returned:

| Signal | Result |
| --- | --- |
| Backend health | ok |
| Costs | warning: `UPLOAD_RECLAIM_WITHHELD` |
| Moderation | degraded: `MODERATION_QUEUE_AGE_SLO_BREACH` |
| Open moderation reports | 1, approximately 64 hours old |

The subject report has been open since September 27, exceeding the existing
24-hour review SLO. Its metadata does not identify an audit fixture; no matching
fixture report was found in the audit evidence. Treat it as a real moderation
case for operator review at `/admin/moderation`. No report was dismissed, no
threshold changed and the watchdog incident was not marked resolved.

The full protected HTTP response could not be fetched locally: production ops
secrets are sensitive and do not pull back from Vercel; the available local cron
credential returns 401. The table above is a direct read-only collector result
using production data, not a claim that the live ops endpoint was authenticated.
It independently reproduces a sufficient cause for the observed 503.

Private evidence: `.audit-evidence/backend-section-05l/`. It includes before and
after browser snapshots, service test output, collector output and fixture setup.
Do not publish private operational data or credentials.
