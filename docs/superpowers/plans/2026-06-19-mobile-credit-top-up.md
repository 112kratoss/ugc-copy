# Mobile Credit Top-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile pricing page's three large purchase cards with one compact, accessible credit-pack selector and one dynamic purchase action.

**Architecture:** Keep RevenueCat orchestration in the existing Expo route. Add a pure pricing view-model module for default selection, selected-plan resolution, display pricing, and button copy so the redesign's decision behavior is testable without rendering native purchase APIs.

**Tech Stack:** Expo Router, React Native, TypeScript, RevenueCat `react-native-purchases`, TanStack Query, Vitest.

**Approved iteration:** The final package selector uses a horizontal snap carousel with side peeks, Creator centered initially, tap and swipe selection, and a compact position indicator. This supersedes the grouped-row rendering described in Task 2 while preserving the same tested pricing view model and purchase flow.

---

### Task 1: Pricing Selection View Model

**Files:**
- Create: `ugc-mobile/lib/pricing-view-model.ts`
- Create: `ugc-mobile/__tests__/pricing-view-model.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOBILE_PRICING_PLAN_ID,
  formatPricingDisplayPrice,
  getPurchaseButtonLabel,
  resolveSelectedPricingPlan,
} from '../lib/pricing-view-model';

describe('mobile pricing selection', () => {
  it('selects the popular Creator pack by default', () => {
    expect(DEFAULT_MOBILE_PRICING_PLAN_ID).toBe('creator');
  });

  it('resolves a selected plan and falls back to Creator', () => {
    expect(resolveSelectedPricingPlan('pro').id).toBe('pro');
    expect(resolveSelectedPricingPlan('missing' as never).id).toBe('creator');
  });

  it('prefers a native store price and formats the web estimate otherwise', () => {
    const plan = resolveSelectedPricingPlan('creator');
    expect(formatPricingDisplayPrice(plan, '₹1,799')).toBe('₹1,799');
    expect(formatPricingDisplayPrice(plan, null)).toBe('Web estimate Rs 1,660');
  });

  it('builds concise purchase button states', () => {
    const plan = resolveSelectedPricingPlan('creator');
    expect(getPurchaseButtonLabel({ plan, price: '₹1,799' })).toBe('Buy 2,000 credits · ₹1,799');
    expect(getPurchaseButtonLabel({ plan, price: '₹1,799', loading: true })).toBe('Loading store price...');
    expect(getPurchaseButtonLabel({ plan, price: '₹1,799', processing: true })).toBe('Processing purchase...');
  });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `cd ugc-mobile && npm test -- pricing-view-model.test.ts`

Expected: FAIL because `../lib/pricing-view-model` does not exist.

- [x] **Step 3: Implement the view model**

```ts
import { MOBILE_PRICING_PLANS, type MobilePricingPlan, type PricingPlanId } from './pricing';

export const DEFAULT_MOBILE_PRICING_PLAN_ID =
  MOBILE_PRICING_PLANS.find((plan) => plan.popular)?.id ?? MOBILE_PRICING_PLANS[0].id;

export function resolveSelectedPricingPlan(planId: PricingPlanId): MobilePricingPlan {
  return MOBILE_PRICING_PLANS.find((plan) => plan.id === planId)
    ?? MOBILE_PRICING_PLANS.find((plan) => plan.id === DEFAULT_MOBILE_PRICING_PLAN_ID)
    ?? MOBILE_PRICING_PLANS[0];
}

export function formatPricingDisplayPrice(plan: MobilePricingPlan, nativePrice?: string | null) {
  const trimmedNativePrice = nativePrice?.trim();
  return trimmedNativePrice || `Web estimate Rs ${plan.webPriceInr.toLocaleString('en-IN')}`;
}

export function getPurchaseButtonLabel({ plan, price, loading = false, processing = false }: {
  plan: MobilePricingPlan;
  price: string;
  loading?: boolean;
  processing?: boolean;
}) {
  if (processing) return 'Processing purchase...';
  if (loading) return 'Loading store price...';
  return `Buy ${plan.credits.toLocaleString('en-IN')} credits · ${price}`;
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `cd ugc-mobile && npm test -- pricing-view-model.test.ts`

Expected: PASS with four tests.

### Task 2: Compact Top-Up Selector

**Files:**
- Modify: `ugc-mobile/app/(tabs)/pricing.tsx`
- Test: `ugc-mobile/__tests__/pricing-view-model.test.ts`

- [x] **Step 1: Add selection state and derived purchase data**

```ts
const [selectedPlanId, setSelectedPlanId] = useState<PricingPlanId>(DEFAULT_MOBILE_PRICING_PLAN_ID);
const selectedPlan = resolveSelectedPricingPlan(selectedPlanId);
const selectedNativePackage = packagesByProductId.get(selectedPlan.productId);
const selectedPrice = formatPricingDisplayPrice(selectedPlan, selectedNativePackage?.product.priceString);
const purchaseBusy = busyProductId === selectedPlan.productId;
const purchaseDisabled = !isConfigured || packageQuery.isLoading || !user || !selectedNativePackage || busyProductId !== null;
```

- [x] **Step 2: Replace metric cards and plan cards with one grouped selector**

```tsx
<Card accent="commerce" padding="sm">
  <View style={{ padding: appTheme.spacing.compact, gap: 4 }}>
    <Kicker color="commerce">Available balance</Kicker>
    <AppText variant="sectionTitle" style={{ fontVariant: ['tabular-nums'] }}>
      {(credits ?? 0).toLocaleString('en-IN')} credits
    </AppText>
    <AppText variant="caption" color="muted">{storeLabel} · {isConfigured ? 'Ready' : 'Setup needed'}</AppText>
  </View>
</Card>

<Card padding="sm" style={{ overflow: 'hidden', gap: 0 }}>
  {MOBILE_PRICING_PLANS.map((plan, index) => (
    <PricingPlanRow
      key={plan.id}
      plan={plan}
      price={formatPricingDisplayPrice(plan, packagesByProductId.get(plan.productId)?.product.priceString)}
      selected={plan.id === selectedPlanId}
      showDivider={index > 0}
      onPress={() => setSelectedPlanId(plan.id)}
    />
  ))}
</Card>

<PrimaryButton
  label={getPurchaseButtonLabel({ plan: selectedPlan, price: selectedPrice, loading: packageQuery.isLoading, processing: purchaseBusy })}
  onPress={() => void buyCredits(selectedPlan.productId)}
  loading={purchaseBusy}
  disabled={purchaseDisabled}
  accent="commerce"
/>
```

The local `PricingPlanRow` uses a `Pressable` with `accessibilityRole="radio"`, `accessibilityState={{ selected }}`, a 44-point minimum height, amber selected tint, a Lucide `Check` icon, existing typography, and a divider only between rows.

- [x] **Step 3: Preserve purchase and restore state behavior**

Keep `buyCredits`, `restore`, RevenueCat package lookup, API synchronization, profile refresh, setup/auth/query status blocks, and notice output unchanged. Disable restore while any purchase is busy and disable purchase while restore is busy.

- [x] **Step 4: Run focused and full verification**

Run:

```bash
cd ugc-mobile
npm test -- pricing-view-model.test.ts iap.test.ts iap-entitlements.test.ts
npm run typecheck
npm test
```

Expected: all focused tests pass, TypeScript reports no errors, and the full Vitest suite passes.

- [x] **Step 5: Run the Android visual pass**

Launch the existing Android development target, open the Pricing tab, and verify package selection, dynamic CTA copy, unavailable store state, purchase notice spacing, restore action, safe-area padding, and tab-bar clearance at the phone viewport.
