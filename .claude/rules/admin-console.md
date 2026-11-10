---
paths:
  - "**/src/app/admin/**"
  - "**/src/app/api/admin/**"
  - "**/src/lib/admin-*"
---

# Admin console (`/admin`)

Moved unchanged from `AGENTS.md` on 2026-10-18 so it loads only where it applies; the core file keeps a summary and points here.

A browser-only operator console living in the same Next.js app under the
`src/app/admin/(console)/` route group; `/admin/login` sits outside the group so
it renders without the console chrome. Areas: overview (reuses the
`/api/ops/*` collectors), moderation queue, users & credits, revenue, payouts,
referrals, content, operator activity, system.

- **Auth is a single master operator**, not per-person accounts: `ADMIN_USERNAME`
  plus a scrypt `ADMIN_PASSWORD_HASH`, an HMAC session cookie signed with
  `ADMIN_SESSION_SECRET`, and `ADMIN_REVIEWER_USER_ID` — which **must be a real
  `auth.users` id** because moderation writes it to `reviewed_by`, a foreign key.
  Missing or malformed values fail closed. Mint them with `npm run admin:credentials`.
- `ADMIN_PASSWORD_HASH` is dot-delimited base64url, **never** the conventional
  `$`-delimited MCF form — Next.js loads `.env` through dotenv-expand, which
  would read `$16384`/`$<salt>` as variable references and silently corrupt it.
- **Two gates, deliberately.** `src/proxy.ts` rejects unauthenticated `/admin` and
  `/api/admin` traffic at the edge (Web Crypto only — `admin-password.ts` uses
  `node:crypto` and must never be imported there), and every page and route
  re-checks via `admin-auth.ts`. Middleware is convenience; the route check is
  the boundary.
- Identity resolution is isolated in `admin-identity.ts` so adding per-person
  admin accounts later changes that module, not the console.
- Moderation actions reuse `moderation-ops.ts`, so the console and
  `npm run ops:moderation` share one transactional take-down path.
- Credit adjustments go through `apply_admin_credit_adjustment` (idempotency
  key, row lock, mandatory reason) with the balance policy in
  `admin-credit-adjustment-service.ts`: goodwill → promotional, refund →
  purchased, clawback → negative promotional. Reversing a real payment stays
  with `reconcile_credit_purchase_adjustment`, not the console.
- Referral decisions (`/admin/referrals`: block or unblock one referral's
  rewards, switch an inviter's link off or on) go through
  `set_referral_attribution_reward_state` and `set_referral_code_enabled`, which
  write the append-only `referral_review_events` trail in the same transaction
  (mandatory reason, reviewer from the session). The abuse guard writes its own
  blocks there as `source = 'system'`, and never overwrites an operator's
  decision. A blocked referral writes no purchase event, so an unblock is paid
  by the hourly reconciliation, not by the console. Taking back credits already
  paid is a credit adjustment. The runbook's "The abuse guard and the
  operator's controls" has the rules.
- Revenue reporting must exclude `transactions.mobile_product_id IS NOT NULL`:
  a mobile IAP writes **both** a `transactions` row and a
  `mobile_store_transactions` row (linked by `source_record_id`), so counting
  `transactions` wholesale double-counts every mobile purchase.
