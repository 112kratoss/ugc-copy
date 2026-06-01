import { MOBILE_PRICING_BY_PRODUCT_ID } from './pricing';

export type MobilePurchaseEntitlement =
  | { type: 'credits'; productId: string; credits: number }
  | { type: 'marketplace_unlock'; productId: string; assetId: string }
  | { type: 'post_resource_unlock'; productId: string; postId: string };

export function resolveCreditEntitlement(productId: string): MobilePurchaseEntitlement | null {
  const plan = MOBILE_PRICING_BY_PRODUCT_ID[productId];
  if (!plan) return null;
  return { type: 'credits', productId, credits: plan.credits };
}
