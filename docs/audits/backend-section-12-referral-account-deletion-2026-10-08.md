# Section 12C — referral history across account deletion

Status: [deployed and independently verified](backend-section-12-referral-deletion-release-2026-10-08.md). Local/CI Auth/SQL controls, standard release, exact live readback and both bounded production rollback probes pass.

Deleting either participant after referral settlement failed in Auth because its
cascades attempted to delete append-only financial ledger rows. Two actual
service/Auth failures reproduce; the same deletion path passes for both unsettled
participants and an account without a referral relationship. Auth logs confirm
`referral audit rows are append-only`. An earlier fixture inserted users directly
in SQL without GoTrue registration; its apparent missing-user response is retained
as invalid fixture evidence, not the application reproduction.

## Change

The CLI-created migration makes the live Auth references nullable and retains
original UUIDs in guarded detached identity fields. Transactions and the referral
code/visit/attribution/reward/event/ledger chain survive deletion. The identity
trigger allows only FK-driven detachment after Auth disappears and rejects
reassignment, invented detached identity and changes to retained identity. The
append-only ledger exception permits only this exact identity transition; amounts,
event keys and other ledger fields remain immutable. No trigger is disabled.

Auth deletion disables the old referral code, removes visit hashes/destination,
and completes outstanding notification work for that recipient. Surviving
beneficiaries still receive their notifications. Refund and restore apply only to
live beneficiaries; the deleted beneficiary's reward records retain their last
balance effect. A retained transaction preserves whether a base grant had actually
applied, so a refund after deletion cannot erase the evidence needed for a later
restore or manufacture a grant for an ungranted purchase. Detached purchases remain
in the recovery selector; their surviving inviter can receive a reward even when
settlement was interrupted until after buyer deletion. An index supports detached
attribution lookup.

Mobile credit receipts also retain the original account UUID for late adjustment
identity. This permits only the original owner’s credit adjustment; it does not
make the receipt available for another account’s restore, and does not broaden
noncredit entitlement restoration.

The change retains all transaction history after account deletion, including
transactions without referral rewards, because purchase adjustments may depend on
it. Existing admin revenue mapping already accepts null live owner IDs. Original
UUIDs remain private reconciliation identity, not an active account or a reusable
referral code. Real store callback and refund delivery still need their separate
provider-backed evidence.

## Verification

- **16 actual local Auth/PostgREST/SQL cases pass**, including the two reproduced
  failures, three positive controls, late refund/restore for either deleted party,
  duplicate refunds, accurate returned balances, deleted-recipient notification
  cancellation, both beneficiaries deleting, ungranted purchase protection,
  immutable ledger/identity rejection, interrupted settlement recovery, and
  concurrent deletion versus settlement/notification delivery with retry. App Store
  and Play Store cases use the actual authenticated webhook handler with local
  PostgREST/SQL, verify late refund/restore after buyer deletion, and reject a
  different receipt owner. Both cases failed with identity_mismatch before the
  mobile receipt and transaction reconciliation guards were extended.
- Candidate response verification caught a stale `remaining_credits` value after
  referral reconciliation; the response now rereads the final balance. A separate
  failing candidate test exposed missing recovery for an unsettled deleted buyer;
  the final selector/settlement changes pass that regression.
- **61 existing account-deletion Auth/Storage cases**, **18 notification recovery
  cases**, and **45 focused cases** and **18 existing payment-database cases** pass. The final clean migration replay and
  **2,328 SQL assertions across 108 files** pass. CI runs the new Auth/SQL suite.
- Expanded candidate CI passed web/mobile/browser/API jobs but failed one SQL
  assertion: the new receipt detachment trigger rejected reassignment before the
  existing immutable-receipt trigger, changing its established error message.
  The detachment trigger now runs afterward, retaining both guards and the
  original error contract. An earlier combined local command masked this same
  pgTAP failure behind a successful preparation command; that run is not counted
  as passing. Final standalone pgTAP results and candidate CI are required.
- New trigger functions deny direct client/service execution; retained referral
  tables remain private. Application/test type checks and scoped lint are gated
  before release. Owned fixtures are cleaned using exact IDs in the local suite.
- Production read-only inventory has zero referral attributions, rewards and
  ledger rows. The complete migration plan contains only this migration. The migration was subsequently applied by the standard release; no real customer repair was needed.

Private evidence is under `.audit-evidence/backend-social/referral-deletion-*`.
AUTH-03 and PAY-04 remain open. This is not a certificate for all provider
revocation, all commerce deletion combinations, or historical balance repair.
