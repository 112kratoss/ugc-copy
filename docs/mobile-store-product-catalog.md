# Mobile Store Product Catalog

Direct native-store purchases for marketplace assets and post-resource bundles are intentionally fail-closed until real products are provisioned. The current mobile app unlocks these resources with credits; only the three existing credit top-up SKUs are seeded automatically.

Resource prices are author-controlled, free-form USD cent amounts. Do not seed guessed product IDs or manufacture catalog rows for every possible price. A catalog row is authority to exchange a verified store transaction for a specific entitlement tier, so it must correspond to an actual consumable product configured in RevenueCat and every enabled native store. Tier products must be consumable because one user may legitimately buy multiple different resources at the same price.

## Provisioning a supported tier

1. Choose the resource type and exact USD-cent tier to support. Marketplace and post-resource products are separate even when their prices match.
2. Create the same product identifier and price in App Store Connect and Google Play, then attach both products to RevenueCat. The current catalog assumes one shared active product identifier per entitlement type and price tier.
3. With a service-role administration client, provision the exact product. Never expose this RPC to a mobile or authenticated user client.

```sql
select public.provision_mobile_store_product(
  'magicbooklet.marketplace.usd900',
  'marketplace_unlock',
  900,
  'USD'
);

select public.provision_mobile_store_product(
  'magicbooklet.post-resource.usd1200',
  'post_resource_unlock',
  1200,
  'USD'
);
```

The function is insert-only for product authority. It rejects credit products, non-USD resource products, invalid prices, conflicting product identities, and a second active product for the same entitlement tier. Product, entitlement, price, currency, and credits are immutable after insertion.

Run the deployment preflight before enabling direct resource IAP:

```sql
select * from public.list_mobile_store_product_provisioning_gaps();
```

Each returned row is an active resource price tier for which `create_mobile_purchase_intent` will return `product_not_configured`. An empty result means every currently active price tier is provisioned; it does not replace sandbox purchases in Apple, Google, and RevenueCat.

To retire or reactivate a non-credit product without changing its authority:

```sql
select public.set_mobile_store_product_active(
  'magicbooklet.marketplace.usd900',
  false
);
```

Pending intents keep their immutable product snapshot, and refund/revoke handling keeps working after catalog deactivation.

## Account deletion and audit retention

Account deletion anonymizes `mobile_purchase_intents.user_id` and `mobile_store_transactions.user_id` through `ON DELETE SET NULL`. It deliberately retains the immutable intent snapshot, provider transaction identity, price, currency, entitlement, source-record reference, and settlement state needed for financial reconciliation and duplicate-transaction defense. The existing immutability triggers permit only the one-way non-null-to-null identity transition; they continue to reject reassignment to another account or restoration of a deleted identity.

Operational cleanup must not delete settled ledger rows. Once a user link has been anonymized, purchase replay and adjustment RPCs fail their null-safe identity check instead of applying credits or entitlement changes to a deleted account. The associated `updated_at` value records when the foreign-key anonymization occurred.

Before promoting a migration that changes either mobile table, test account deletion with a settled sandbox purchase and verify all three outcomes in one transaction boundary: the Auth user is gone, the durable account-deletion job reaches `completed`, and both retained mobile rows have a null `user_id` while their purchase-intent linkage and settlement identity remain present.

## Backfilled transactions

The legacy marketplace and post-resource order tables did not store the RevenueCat product ID. Their store transaction IDs are reserved globally during migration, but their ledger product begins with `legacy.` and cannot safely accept a refund event until an operator binds the actual product.

After verifying the historical provider order and provisioning its exact type/price catalog product, bind it once:

```sql
select public.bind_legacy_mobile_store_transaction_product(
  'mobile_app_store_2000000123456789',
  'magicbooklet.marketplace.usd900'
);
```

The binding RPC only permits a configured product whose entitlement type, amount, currency, and credit count exactly match the immutable backfilled ledger. Until binding is complete, a matching RevenueCat adjustment returns a retryable server error instead of silently acknowledging an event that could not revoke access. After binding, refund and `REFUND_REVERSED` events use the normal revoke/restore path.

## Release gate

- Keep direct marketplace/post native purchasing hidden while any intended tier is unprovisioned.
- Confirm the product ID returned by a server-created intent is offered on both target platforms.
- Sandbox-purchase each supported entitlement type and tier.
- Refund it and confirm access is removed, counters are decremented once, and a duplicate webhook is idempotent.
- Send `REFUND_REVERSED` and confirm access and counters are restored once.
- Check for unbound legacy rows before relying on automated legacy refunds:

```sql
select external_order_id, entitlement_type, amount_subunits, currency
from public.mobile_store_transactions
where product_id like 'legacy.%';
```
