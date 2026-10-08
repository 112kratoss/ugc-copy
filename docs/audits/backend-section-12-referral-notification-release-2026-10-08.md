# Section 12B — verified referral notification recovery release

PR [#403](https://github.com/112kratoss/ugc-copy/pull/403) merged as
`98f55011c8e820ae6e11acdb9d5f4dfb609b496e` at 2026-10-07 17:47:29 UTC.
Candidate Quality `37659876117` and exact-main Quality `37661798356` passed all
five jobs. Standard production release `37663113075` succeeded.

Independent readback at 2026-10-07 19:55:24 UTC confirms the exact live build,
four runtime file hashes, all three function bodies/ACLs and the new schema
against clean replay. Existing schema is unchanged. The 110 previous security
findings remain, with only the expected INFO policy-free private-outbox finding
added (111 total). Migration `20261007150522_referral_reward_notification_outbox.sql`
maps to production ledger version `20261007175810`.

Five bounded production ROLLBACK controls pass: exact reward balances, two
immutable ledger events, two notifications, two single-attempt completed queue
entries, and no push work. Separate cleanup confirms zero fixture users,
transactions, programs, ledger events or notifications. Live feed 200, admin
login redirect 307, unsigned webhook 401 and protected referral cron 401 pass.
No real customer balance or provider delivery was changed.

The first candidate passed 7,499 web tests but failed lint on a CJS test-worker
require import. Dynamic import corrected that issue; the intermediate check was
cancelled by normal concurrency when independent #404 was merged into the audit
branch. The final combined candidate passed all five gates before merging; the
verified #404 parent and immediate mobile-store-idle gate were checked afresh.

This closes the reproduced lost-notification defects. It does not certify all
referral/account-deletion combinations, genuine push delivery or the outstanding
historical administrative credit reconciliation. Raw evidence is private under
`.audit-evidence/backend-social/referral-notification-release/`.
