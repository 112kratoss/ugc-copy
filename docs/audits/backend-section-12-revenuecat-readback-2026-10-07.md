# RevenueCat configuration and receipt readback

Read-only connector inspection on October 7, 2026 reached the existing
Magicbooklet project. No products, grants, subscriptions, webhooks, secrets,
customer balances or receipts were changed, and no purchase/refund was made.

The App Store and Play Store apps both use `com.magicbooklet.mobile`. RevenueCat
reports their required store credential configuration flags as present. All six
store credit products are active and consumable: starter, creator and pro on
each platform. The current default offering maps each of those three packages
to its corresponding product on both platforms. The four Test Store products
are separate and are not included in the current offering.

The sole webhook targets the expected
`https://magicbooklet.com/api/mobile/commerce/revenuecat-webhook`, has no event
or app filter, and accepts **production events only**. This does not establish
its authorization-header value or delivery success. The connector cannot read
the configured authorization header, send a test delivery, or inspect delivery
attempts. No secret was rotated to work around that limitation. Sandbox receipt
sync remains supported by the backend; sandbox refund webhook delivery is not
covered by this production-only integration.

A bounded read of the three customers already represented in the earlier 5G
receipt evidence returns eight purchases with complete pagination. All eight
match the freshly read production ledger by owner, store, store transaction ID
and product at **14:59:23 UTC**. All are provider-verified sandbox purchases in
`owned` state. All eight ledger rows are active, with successful source
transactions, applied credit effects, and matching source/owner/product bindings.
This corroborates the earlier receipt-identity check without altering history.

The connector returned an empty event list for each of those three customers.
That is an observation of this API response, not evidence that no events occurred
or that delivery succeeded. There is no newly observed missing-ID transition,
refund/reversal, webhook acknowledgement, or installed-client restore.
**PAY-05 remains external.** Genuine sandbox purchase/refund/restore and provider
delivery still require suitable provider/device evidence; synthetic requests
and current configuration do not replace it.

Private evidence under `.audit-evidence/backend-social/`:
`revenuecat-configuration-2026-10-07.json`,
`revenuecat-receipts-private-2026-10-07.json`,
`revenuecat-current-ledger-private-2026-10-07.json`, and the sanitized
`revenuecat-receipt-comparison-2026-10-07.json`. Do not publish customer or receipt
identifiers from the private files.
