# Mobile Credit Top-Up Redesign

## Goal

Make the mobile pricing screen feel like a quick credit recharge instead of a comparison between subscription plans. Preserve the existing Starter, Creator, and Pro package names for now, but make credit amount and store price the primary decision information.

## Scope

- Redesign only the Expo mobile pricing screen.
- Keep the existing three RevenueCat products, entitlement mapping, purchase synchronization, restore flow, authentication requirement, and web fallback pricing.
- Do not change the web pricing page or add custom credit amounts.

## Screen Structure

1. A compact header names the task as `Top up credits` and briefly explains that credits are one-time purchases.
2. A single balance panel shows the current credit balance and native store readiness without two competing metric cards.
3. A horizontal snap carousel presents Starter, Creator, and Pro one focused card at a time, with adjacent cards peeking in to communicate that the surface is swipeable.
4. Each card prioritizes the credit amount and price. The package name and short usage description are supporting text. Creator keeps a small `Popular` marker.
5. Creator is centered initially because it is the existing popular package. Swiping or tapping an adjacent card updates the selected package, accent treatment, `1 of 3` indicator, and purchase action together.
6. One primary button below the carousel states the exact purchase, such as `Buy 2,000 credits for ₹1,660`. It updates when selection changes and shows the existing processing state during purchase.
7. `Restore purchases` remains a quiet secondary action below the purchase panel.

## Interaction And Data Flow

- Package selection is local UI state keyed by the existing pricing plan ID.
- RevenueCat offerings continue to map to plans through product IDs.
- Native store prices replace web fallback prices whenever offerings are available.
- Pressing the primary button purchases only the selected native package, normalizes its transaction, syncs the entitlement with the API, refreshes the profile, and reports success through the existing notice state.
- If the user is signed out, the purchase action remains disabled and the existing sign-in status message is shown.
- Missing store keys, unavailable products, query failures, purchase failures, success notices, and restore results continue to use shared status blocks.

## Visual Direction

- Preserve the premium dark mobile theme and existing amber commerce accent.
- Use one focused carousel card instead of three vertically stacked cards. Keep enough of the neighboring cards visible to teach the swipe interaction without extra instructions.
- Use existing `appTheme` spacing, typography, radii, colors, shared text, button, screen, pill, and status primitives.
- Keep all selectable rows and actions at least 44 points high.
- Preserve safe-area and bottom-tab spacing; the purchase CTA must remain comfortably above the tab bar.
- Avoid decorative imagery, extra metrics, gradients, or new navigation.

## Component Boundaries

- Keep purchase orchestration in the pricing route.
- Add a small pricing view-model helper only for deterministic selection and button-copy behavior that benefits from unit testing.
- Keep package metadata in `lib/pricing.ts`; do not duplicate product IDs or credit totals in the screen.
- Use a focused selectable-card component inside the pricing screen unless the pattern becomes shared elsewhere.

## Error And Loading States

- Package loading disables the purchase button and uses concise loading copy.
- A configured store with no matching selected package disables purchase and explains that the product is not ready.
- Purchase and restore operations cannot run concurrently.
- Existing store setup, authentication, package-query error, purchase notice, and restore notice messages remain visible without pushing the primary decision below unnecessary summary cards.

## Verification

- Unit-test default selection, selected-package resolution, carousel snap offsets, store-price preference, fallback-price formatting, and dynamic purchase button copy.
- Run the focused tests first, then the full mobile test and typecheck suites.
- Render the Android mobile screen and verify the default, selected-package, unavailable-store, loading, and notice layouts at a phone viewport.
- Confirm the tab bar does not cover the selector, CTA, or restore action.
