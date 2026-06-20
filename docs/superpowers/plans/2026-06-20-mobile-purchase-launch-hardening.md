# Mobile Purchase Launch Hardening Implementation Plan

> **For Codex:** Execute this plan task by task, keeping unrelated working-tree changes intact.

**Goal:** Close the production credit-minting authorization gap and add idempotent RevenueCat refund reconciliation without changing the existing mobile purchase UI or successful purchase behavior.

**Architecture:** User-scoped Supabase clients continue to authenticate requests and read or write user-owned application data. Every balance mutation moves behind service-role-only RPC execution. RevenueCat refund events enter through an authenticated server webhook and call one transactional database RPC that marks the original purchase refunded and reverses its exact credited amount once.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, Supabase/Postgres, RevenueCat webhooks, Expo/React Native.

---

## Task 1: Capture the authorization regression

**Files:**
- Create: `src/__tests__/credit-rpc-security.test.ts`

1. Add a static regression test that locates the new migration and asserts all balance-mutating functions revoke execution from `PUBLIC`, `anon`, and `authenticated` while granting `service_role`.
2. Assert the migration removes authenticated/user mutation access to `transactions` while preserving user-owned reads.
3. Run the focused test and confirm it fails before the migration exists.

## Task 2: Move legitimate callers to privileged clients

**Files:**
- Modify: `src/app/api/razorpay/verify/route.ts`
- Modify: `src/app/api/generate/route.ts`
- Modify: `src/app/api/generate-image/route.ts`
- Modify: `src/app/api/generate-video/route.ts`
- Modify: `src/lib/generation-services.ts`
- Modify affected route/service tests.

1. Add failing assertions that authentication and user-owned data operations use the user client, while `add_credits`, `deduct_credits`, `refund_credits`, `refund_generation`, and `refund_ai_usage_event` use a service client.
2. Use `createServiceClient()` only after authentication succeeds.
3. Pass a dedicated privileged client into generation services for balance mutations; keep the existing user client for RLS-protected generation data.
4. Run focused generation and Razorpay route tests.

## Task 3: Add idempotent RevenueCat refund reconciliation

**Files:**
- Create: `src/lib/revenuecat-webhook.ts`
- Create: `src/app/api/mobile/commerce/revenuecat-webhook/route.ts`
- Create: `src/__tests__/revenuecat-webhook.test.ts`
- Modify: `src/lib/env.ts` or server environment helpers if required.

1. Write failing tests for missing/invalid authorization, irrelevant events, malformed refund events, successful reversal, unknown purchases, and duplicate delivery.
2. Authenticate with a dedicated `REVENUECAT_WEBHOOK_AUTH_TOKEN` using constant-time comparison.
3. Accept RevenueCat non-subscription cancellation/refund events, normalize the original transaction identifier and store, reject user IDs that do not match the credited transaction, and ignore unrelated products/events.
4. Invoke a single service-only database RPC and return retryable server errors only when reconciliation genuinely fails.

## Task 4: Create the targeted database migration

**Files:**
- Create via Supabase CLI: `supabase/migrations/<timestamp>_harden_credit_mutations_and_reconcile_mobile_refunds.sql`

1. Add an idempotent service-only `refund_mobile_credit_purchase` RPC that locks the transaction, verifies user/provider/transaction identity, changes `success` to `refunded`, and subtracts the exact recorded credit grant once.
2. Extend the transaction status constraint for `refunded` and add refund audit timestamps/metadata needed by the RPC.
3. Revoke all credit-mutation RPC execution from `PUBLIC`, `anon`, and `authenticated`; grant only `service_role` (and database owner where appropriate).
4. Remove end-user insert/update/delete access and RLS policies on `transactions`; preserve authenticated select access for a user's own rows.
5. Run local SQL/static tests and review the generated diff.

## Task 5: Reconcile and deploy production migration safely

1. Inspect the remote-only migration record and reconstruct its local history entry without applying the unrelated local-only migration.
2. Apply only the new hardening SQL to the linked production project using a transaction-safe path.
3. Repair migration history only after the SQL succeeds.
4. Query `information_schema`/`pg_proc` grants and RLS policies to prove `anon` and `authenticated` can no longer mutate credits or transactions.
5. Re-run the Supabase security advisor and confirm the relevant findings are cleared.

## Task 6: Full verification and launch boundary

1. Run focused Vitest suites, then the full web test suite and typecheck/lint command supported by the repository.
2. Run the mobile test suite and mobile TypeScript check to prove the carousel purchase UI remains intact.
3. Exercise the deployed webhook without credentials and verify it denies access; do not send a synthetic refund against production data.
4. Verify existing production sync/restore routes still reject unauthenticated requests.
5. Document the remaining external actions: create the webhook auth secret in Vercel and RevenueCat, configure products/offering/store credentials, complete Apple/Google agreements, test with sandbox/license accounts, and submit fresh store builds.
