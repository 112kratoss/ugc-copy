# Section 12C — referral account-deletion release verification

Status: deployed and independently verified on October 8, 2026.

PR [#407](https://github.com/112kratoss/ugc-copy/pull/407) merged as
`d3985f7c8ed4dceea0abddff2766b63f75cc320f`. Candidate Quality
[37717071721](https://github.com/112kratoss/ugc-copy/actions/runs/37717071721)
passed all five jobs. The original merged commit's API job encountered an invalid
local upstream response in one pre-existing admin-collector case (47/48 passed);
the unchanged 48-case local suite passed. Its rerun was superseded by the next
documentation-only main commit. Neither gates nor business assertions were relaxed.

The released build is `cc159f7e7fdea346476543d40756cbe442092261`, containing #407
and documentation-only #409. Exact-main Quality
[37719493430](https://github.com/112kratoss/ugc-copy/actions/runs/37719493430)
attempt 2 passed all five jobs; attempt 1 was cancelled during overlapping
same-branch reruns. Standard production release
[37720962542](https://github.com/112kratoss/ugc-copy/actions/runs/37720962542)
succeeded at 03:07:49 UTC. The migration was applied through that workflow.

Independent readback at 03:08:34 UTC verifies the exact live build, migration
source digest, all ten changed function definitions and ACLs, Auth deletion
trigger, expected changed schema signatures and unchanged remaining schema.
Security advisors remain at 111 findings, with none added or removed. Migration
`20261007174934_retain_referral_history_on_account_deletion.sql` maps to production
ledger version `20261008030458`, under its unique migration name.

The public feed returns 200, unauthenticated admin payouts redirect to login (307),
unsigned provider webhook returns 401, and unsigned referral cron returns 401
with private no-store headers.

Two bounded production rollback probes pass:

- Referral settlement, inviter deletion, targeted surviving notification, late
  refund/restore with accurate surviving balance, immutable retained history,
  buyer deletion and cancellation of deleted-recipient work.
- Mobile credit purchase, buyer deletion, original-owner refund/restore with the
  surviving inviter's balance restored, and rejection of a different owner's
  adjustment and purchase restore.

Both probes use exact synthetic IDs, statement/lock timeouts and ROLLBACK; no
external provider is called. Separate cleanup queries confirm zero users,
transactions, programs, receipts, ledger entries, deletion jobs or notifications
for the applicable fixture sets. Production's pre-release referral inventory was
empty, so no historical referral repair was required.

The 16 local actual Auth/PostgREST/SQL cases and clean 2,328-assertion replay cover
the original failures and lifecycle/concurrency regressions. This closes the
reproduced 12C defects, not all account revocation or financial combinations.
The separately reproduced 12F settlement-progress bug remains open.

Private evidence: `.audit-evidence/backend-social/referral-deletion-release/`.
