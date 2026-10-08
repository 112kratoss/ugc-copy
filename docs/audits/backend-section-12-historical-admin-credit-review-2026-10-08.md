# Section 12D — historical admin-credit review

Status: the specific promotional-only historical adjustment is reconciled by an
existing corrective entry. No new balance or ledger mutation is needed.

The earlier aggregate inventory found one positive promotional-only adjustment
and could not establish its intent or any subsequent correction. A bounded,
read-only review now resolves both questions. The entry was an App Review demo
account top-up on 2026-08-07 at 14:42:45 UTC. It added 25,000 promotional credits
but zero total credits, leaving total spendable credits at 273.

The same account has a later adjustment at 21:44:46 UTC that explicitly states
it corrects the earlier top-up because total spendable credits had not increased.
It adds 25,000 total credits and zero promotional credits, leaving balances of
25,273 total / 25,000 promotional. The two entries together have exactly the
intended matched 25,000 total/promotional effect. Applying another compensation
would duplicate that correction.

The account has subsequent purchase and usage activity. Current balances are
26,763 total / 24,890 promotional; those values are a readback, not an independent
reconstruction of every subsequent event. The read-only query found two later
successful applied purchases, 14 generation rows and four AI-usage rows. This
review certifies the existing correction of this one identified historical
mistake; it does not certify every later spend, refund or provider event.

Private identifiers, idempotency keys and full reason text are retained in
`.audit-evidence/backend-social/historical-admin-credit-review-private.json` and
`historical-admin-credit-followup.json`. No secret, account identifier or customer
balance was changed. PAY-04 remains open for its other financial lifecycle work;
this historical adjustment is no longer a pending repair decision.
