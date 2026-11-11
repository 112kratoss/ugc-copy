# Mobile payout request — plan (2026-11-11)

Status: **built on `feat/mobile-payout-request` (2026-11-11), in review; the per-method details check is the owner's TODO.** Owner asked on 2026-11-11 ("Yes, plan it") after seeing that the app shows the
payout balance but sends creators to the website to withdraw.

## What exists today

- **Server** — done, no change needed for the request itself. `GET /api/creator/payouts` (state) and
  `POST /api/creator/payouts` (`{ payoutMethod, payoutDetails }`) in `src/lib/creator-payouts-route-adapter-service.ts`:
  registered accounts only, bearer tokens accepted, `POST_MUTATION_RATE_LIMIT`, whole balance only, one open request,
  $100 floor, methods `upi` | `bank_transfer`, details 3–500 characters, encrypted at rest. Refusals carry `code`:
  `BELOW_MINIMUM`, `ALREADY_PENDING`, `INVALID_METHOD`, `METHOD_UNAVAILABLE`, `INVALID_DETAILS` (plus 429 from the rate
  limit, 401 for a guest).
- **Web** — `src/app/marketplace/sell/PayoutPanel.tsx`: balance, progress to $100, Withdraw form (UPI, Indian bank
  transfer, PayPal and International transfer as "Coming soon"), pending callout, rejection note, payout history.
- **App** — reads only. `ugc-mobile/lib/use-creator-payout-state.ts` (`api.getCreatorPayoutState`), the Profile Wallet
  card (`getWalletCardContent`), and `PayoutBalance` on `app/seller-dashboard.tsx`, whose only action is
  "Request a payout on the web". Payout notifications (`creator_payout_paid` / `_rejected`) already open Recipe Sales.

## What changes

### 1. Shared payout policy (web + server + app)

Today the method list, labels, placeholders, the 500-character cap and the "how a stored method reads" table live in
two places (`creator-payouts.ts` on the server, `PayoutPanel.tsx` on the web). A third copy in the app would drift the
way recipe reading did before 2026-10-29, so move them into a shared folder, as the other shared policies are:

- `ugc-mobile/lib/creator-payout-policy/creator-payout-policy.ts` with its own self-contained `tsconfig.json` (no
  `extends`; `vercelignore-shared-catalog-modules.test.ts` checks it). No React Native, Expo or Node imports.
- Holds: `CREATOR_PAYOUT_METHODS` (value, label, placeholder, keyboard hint), the coming-soon labels, the details
  bounds (3–500), `formatPayoutMethod`, the history row's words (Paid / Rejected / In progress), and the
  **details check** (see "Your part" below).
- Imported by `src/lib/creator-payouts.ts` (server validation), `PayoutPanel.tsx` (web form) and the app.

### 2. Contract

- `contracts/mobile-api-operations-v1.json`: add `requestCreatorPayout` — `POST /api/creator/payouts`, auth required.
- `contracts/mobile-api-v1.json`: pin the POST request body, the success answer (`requestId`, `amountTokenSubunits`)
  and every refusal `code` above, so both suites fail on a breaking change.
- Both fixture tests: `src/__tests__/mobile-api-contract-fixture.test.ts` and
  `ugc-mobile/__tests__/mobile-api-contract-fixture.test.ts` (add the call next to `getCreatorPayoutState`, line ~553).

### 3. App: client and view model

- `ugc-mobile/lib/api-client.ts`: `requestCreatorPayout({ payoutMethod, payoutDetails })` → POST, typed answer and
  error code; the default 30 s timeout is enough.
- `ugc-mobile/lib/creator-payout-view-model.ts` (pure, vitest): from the payout state to what the card draws —
  `loading | unavailable | progress | ready | pending | rejected | needsRefresh` — plus the progress fraction, the
  caption ("Ready to withdraw · lifetime $8.50"), the pending line ("arrives within 14 days"), and history rows.
  Mirrors the web panel's rules one for one, including "a request accepted whose follow-up read failed hides Withdraw
  until a read shows it".

### 4. App: screens

- **Recipe Sales card** (`PayoutBalance` in `app/seller-dashboard.tsx`): replace the web link with the view model's
  states — progress bar under $100 with "Withdraw from $100.00, paid in INR to UPI or an Indian bank.", a primary
  **Withdraw $X** button when ready, the pending callout, the rejection note, and a collapsible **Payout history**.
- **Withdraw screen** — a pushed route `app/payout-request.tsx` (registered in `app/_layout.tsx` as "Withdraw"), not a
  sheet: a screen needs no overlay-host work, and an RN `Modal` holding a field is refused by `hig-modality.test.ts`.
  - "Pay me by": `ChoiceChip`s for UPI and Indian bank transfer; PayPal and International transfer drawn disabled with
    "Coming soon" (same as the web).
  - "Payout details": `AppTextInput`, placeholder per method, `autoCapitalize="none"` and `autoCorrect={false}`, an
    email-style keyboard for UPI. Caption: never paste a full account number.
  - **Request payout** → a confirm dialog (`showConfirmDialog`: "Withdraw $110.00 to name@bank by UPI?") because it
    moves the whole balance → POST → on success invalidate `[CREATOR_PAYOUTS_QUERY_KEY]` (Profile's Wallet card
    follows), go back, show "Payout requested".
  - Refusals show the server's words inline; 409 `ALREADY_PENDING` refreshes the state and goes back.
  - `KeyboardAvoidingArea` around the form; `usePreventRemove` while a request is in flight.
- Rules that apply: `.claude/rules/mobile-ui.md` (44pt hit regions, 11pt type, colours through `useAppTheme()`),
  `.claude/rules/mobile-runtime.md` (keyboard, no Modal fields).

### 5. Your part

The **details check** in the shared policy — `checkPayoutDetails(method, text)` returning `null` or the words to show.
It runs in the web form, the app form and the server, so it decides what every creator can submit. The choice is how
strict to be: a strict UPI pattern (`handle@psp`) catches typos before a request is filed, but a too-tight pattern
refuses real IDs and the creator cannot get paid; a loose check leaves you to discover a bad ID only when the payment
fails. The bank-transfer text is free-form (name, last four digits, contact). A stub with a TODO will be in place
when the build starts.

## Shipping

- **Web/server first** (shared policy, contract, server import): ordinary PR → Quality → `production-release.yml`.
- **App second**, as an OTA: no native module is added, so `node ugc-mobile/scripts/publish-ota.mjs --platform all`
  (publish only on the owner's word for that update). Binaries without the OTA keep the web link.
- **Review**: the diff touches payouts (payments), so `/code-review max` per AGENTS.md before merging.

## Verification

- vitest: view model, api client, contract fixtures, the shared policy's check; HIG and theme guard tests.
- iOS simulator first, then Android emulator, **against the local Supabase stack** with a seeded wallet over $100
  (`sibling-supabase-stack-replay-recipe`). Never submit a request on production: the owner's production wallet is set
  to $110.00 by hand on 2026-11-11 (balance `1100000`, was `85000`) and a request there would be a real payout.
- Film the Withdraw screen's entrance and the keyboard on both platforms.

## Open questions for the owner

1. Confirm dialog before the request — yes (planned) or no?
2. Payout history in the app, or only on the web?
3. Keep a small "Manage on the web" link under the card?
