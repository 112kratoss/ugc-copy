# Backend Section 5G — mobile receipt identity investigation

Date: 2026-09-29. Application baseline: `3fa79f92fe906b934b0e5d7dfcceeaddfede7259`.
Checkout: `/Users/athuls/UGC copy/auth-section-one`; fix branch `codex/mobile-receipt-store-identity`.

## Result

No affected production settlement was found. All eight mobile settlements match
the store transaction ID currently returned by RevenueCat. The suspected
RevenueCat-only → store-ID transition remains **unverified at the provider**.
Controlled local fault injection confirms its financial consequence if it occurs:
two grants for one logical purchase, or an unmatched store refund.

The user subsequently authorized fixing this conditional failure. Settlement now
requires RevenueCat's `store_transaction_id`: verify rejects an incomplete receipt
using the existing 400 response, while restore skips it until a later retry. A
client may still select the receipt using either ID, but only its store ID can key
the grant. Genuine Apple/Google sandbox receipts retain their store/provider.

No migration or customer-data repair is needed for the inspected ledger. The
change is prevention for a reproduced incomplete-response condition; it is not
evidence that RevenueCat exhibited the transition in production or full provider
certification. Release verification is recorded separately when completed.

## Provider contract and live comparison

Sources retrieved on the audit date:

- [RevenueCat Customer Info schema](https://www.revenuecat.com/docs/redocusaurus/openapi-v1-customer-info-model.yaml): non-subscription `id` identifies the purchase; `store_transaction_id` identifies it in the underlying store. The item schema has no required-field list. This does not establish whether a missing store ID is possible for verified Apple/Google purchases or can later appear.
- [Customer response example](https://www.revenuecat.com/docs/api-v1/customers): the non-subscription example omits the store ID. An example is not a field-availability guarantee.
- [Webhook fields](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields): `transaction_id` is the store identifier. It is not the webhook event ID or the REST purchase ID.

Read production through Supabase MCP project `ildfmhozpibwiopeavfg`. Read
RevenueCat v1 customer records for the three existing ledger owners using the
existing operator credential; no purchase, refund, receipt submission, or
provider charge was initiated. All three GETs returned 200 at approximately
10:37 UTC. The receipt evidence saved locally replaces identifiers with shared
opaque labels; it excludes customer attributes, raw receipts and credentials.

| Observation | Result |
| --- | --- |
| Mobile settlements | 8: 6 Apple, 2 Google, all active |
| Live REST receipts corresponding to those settlements | 8 |
| Receipts with both identifiers | 8; all strings; the two IDs differ in every receipt |
| Ledger key matches REST store ID | 8 |
| Ledger key matches REST purchase ID | 0 |
| Mobile credit transactions without a mobile-ledger counterpart | 0 of 8 |
| Source-record, owner or product binding mismatch | 0 |
| Store environment reported by RevenueCat | All 8 sandbox |

The sandbox receipts are genuine provider records, including existing review/test
accounts. They are not client-declared sandbox bypasses. No receipt was rejected
or relabeled, and no customer data was repaired. This sample provides no evidence
about paid production-store receipts or historical field availability. Stored
webhook payloads were not available for a real REST/webhook receipt-pair comparison.

The security advisor baseline remains 1 INFO / 37 WARN / 0 ERROR groups. Logs were
available through MCP; their source inventory was checked, not asserted to prove
successful provider delivery. No DDL was performed.

## Real database checks

Added `src/__tests__/mobile-receipt-identity-database.test.ts`, wired into the
existing Quality database job. All ten cases pass against the isolated Postgres
on port 55322, using service-role RPC execution inside rolled-back transactions:

- Apple and Google each grant exactly 500 credits once across sync by REST ID,
  sync by store ID, sync without a supplied ID, restore, and purchase webhook replay.
- Apple and Google store-ID refunds reach that same settlement; duplicate refund
  events do not subtract again.
- An injected REST receipt lacking its store ID cannot verify a store-ID purchase
  webhook: the HTTP adapter returns 503 and grants nothing.

Four additional prevention cases (sync and restore for each store) failed on the
baseline and pass with the fix. They prove that an ID-only response grants nothing,
a later store-ID response grants exactly once, and the store refund can reverse
that grant.

These tests use synthetic receipt responses matching the observed field structure.
Verification, webhook parsing, restore logic, and financial SQL are real. Only
unrelated notification/referral fan-out is stubbed. They do not certify network
delivery or provider field evolution.

The separate, local-only fault probe deliberately removes the store ID:

1. Sync accepts the REST-only ID and grants 500 credits. A later injected snapshot
   includes the same REST ID plus a store ID. A purchase webhook then completes a
   second settlement: 1,000 credits and two rows in each purchase ledger.
2. After a REST-only settlement, a store-ID refund cannot find the purchase. The
   HTTP adapter returns 503 and the original 500 credits remain.

Both outcomes were reproduced for Apple and Google against real local SQL. The
probe's passing assertions describe the unsafe conditional outcome; they are not
passing prevention tests. The provider transition itself was not observed.

Validation before the fix: 61 relevant tests passed, including the six database controls;
the separate fault probe passed 10 characterization cases (six controls plus four
fault cases). Test TypeScript checking and targeted ESLint passed. `git diff
--check` passed. A separate post-run query found zero fixture settlement rows.

## Compatibility decision and remaining evidence

The fresh pre-release comparison again found eight store-ID ledger keys, zero
REST-only keys, and no unmatched legacy mobile credit transactions. No identifier
rewrite or alias migration is justified for this data. Deferring an incomplete
receipt is the smallest change: it shares the identity already used by refunds
and all observed settlements. The user authorized this prevention fix after the
initial investigation.

Recheck compatibility before promotion and after release. If any REST-only ledger
key appears, stop release and reconcile verified aliases, including refund lookup,
before allowing a later store ID to create another settlement. Never infer alias
bindings from purchase dates or ID shapes. Real paired provider evidence remains
a separate gap; no new store purchase was made during this audit.

Post-fix targeted verification: 65 tests pass, including ten real-Postgres cases;
ESLint and test TypeScript checks pass. The original fault-probe log is historical
baseline evidence; its assertions deliberately describe the pre-fix unsafe state
and are superseded by the new prevention cases.

Other payment audit work remains cross-rail event conflicts, marketplace
concurrency, reporting double-count prevention, and provider-backed delivery,
purchase and refund scenarios. No overall audit coverage percentage is claimed.

## Local evidence

Under `.audit-evidence/backend-section-05g/` (do not blindly commit):

- `receipt-comparison-redacted.json`, `inspect-receipts.cjs`
- `customer-info-model.yaml`
- `identity-fault-probe.test.ts`, `vitest.config.ts`, `fault-probe.log`
- `regression.log`, `typecheck.log`
- `ledger-private.json`: restricted local ledger input, **not for publication**

Prior handoff and Section 1/5F evidence remain intact. The fix PR includes the
previously uncommitted Section 5F release evidence; Section 1 local files remain
untouched. Production release follows exact-main Quality and the standard workflow.
