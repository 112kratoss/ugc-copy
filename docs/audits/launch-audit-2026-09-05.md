# Launch Audit — 2026-09-05

Final pre-launch audit for Magicbooklet, web and mobile together. This file is
the tracker: one conversation per section, one branch and PR per section, and
the section's findings and sign-off are updated **in the same commit** as its
fixes (the convention from the scaling work).

## How the audit is sliced, and why

The audit is organised by **risk domain**, not by page or screen. Every web page
and mobile tab sits on the same `route → adapter → service` layer and the same
Supabase RLS, so "audit the pricing page" and "audit the pricing tab" would
walk the same code twice and still miss the webhook that actually moves the
money. Each domain below covers **both surfaces** and is ordered by blast
radius: sections that can lose money or leak data come first, cosmetic work
comes last, and observability comes just before go-live so it watches the
final build.

The unit tests (741 web, 181 mobile, 40 pgTAP, 5 E2E) already cover the
logic. The audit's job is the part tests cannot see:

1. **External configuration** — provider dashboards, store consoles, Vercel and
   GitHub environments, Supabase Auth settings.
2. **Real end-to-end flows** — real money at the smallest amount, real provider
   generations, real push notifications, on real phones.
3. **Copy, legal, and store metadata** — what the pages and listings claim
   versus what the code does.
4. **Documentation drift** — runbook statements that no longer match config.
5. **Capacity** — what breaks first when a marketing push lands.

## Decisions (owner fills in before Phase 0)

| Decision | Default assumed here | Owner's call |
|---|---|---|
| Launch scope | Public marketing launch of web + both stores, not a soft launch | |
| Target date | Not set; the sections gate the date, not the reverse | |
| Launch blocks on | P0 and P1 only (policy below) | |
| Mobile crash reporting before launch | No (accepted blind spot in the runbook) — revisit in Section I | |
| Supabase PITR / off-platform Storage backup before launch | No (accepted blind spot) — revisit in Section H | |

## Severity policy (so the audit terminates)

| Level | Meaning | Handling |
|---|---|---|
| P0 | Money lost or duplicated, private data exposed, cannot sign in, crash on cold start | Blocks launch. Fixed in the section's PR with a regression test. |
| P1 | A core flow broken for a class of users (guests, Android, paid users, sellers) | Blocks launch. Fixed in the section's PR. |
| P2 | Wrong, but a workaround exists, or cosmetic inside a core flow | Fix in the PR only if under an hour; otherwise file it. |
| P3 | Polish | File it. Never fixed during the audit. |

The section PR fixes P0/P1 and trivial P2 only. Everything larger becomes its
own PR after the audit, otherwise the audit never ends.

## Accounts and devices

Accounts (create once, reuse across sections):

- **Guest** — anonymous session, never signed in.
- **Fresh Google** — a Google account never used on the product (web sign-up path).
- **Apple** — Sign in with Apple on the iPhone.
- **Paid user** — bought the cheapest credit pack with real money on web.
- **Seller** — published one paid resource bundle and one template.
- **Buyer** — a second account that bought the seller's bundle.
- **Admin** — the master operator credential from `npm run admin:credentials`.
- **App Review demo** — the reviewer account; keep credit headroom (a video can cost up to 285 credits).

Devices:

- Desktop Chrome and Safari; mobile Safari on the iPhone for the web surface.
- **A real iPhone** on current iOS and **a real Android phone** (API 33–35 shows the predictive-back and billing behaviour the emulator hides).
- Emulator/simulator only for screen recordings, never as the evidence of a fix.

## Session protocol (every section)

1. New conversation. On `main`, pull, confirm `git status --short --branch` is clean, branch `audit/<section-letter>`.
2. Run the section's **automated** checks first and record the result.
3. Walk the **click-through** with the account matrix on each surface. Record each finding in the section's table with a severity.
4. Fix P0/P1 in the branch. Reproduce first at the layer the bug lives (vitest for logic, E2E or a phone for rendering). Update this file in the same commit.
5. PR → Quality → merge → production release for web. Mobile fixes accumulate into the next binary or OTA (Section F decides which).
6. Fill in the section's sign-off line with the date and the PR/run links.

Never build while a dev server runs; stop any preview before `npm run test:e2e`.

---

## Phase 0 — Baseline board (half a session)

Run everything automated once and turn every red into a finding in the owning
section. Nothing is fixed in Phase 0.

Web (repo root, no dev server running):

```bash
npm ci && npm test && npm run lint && npm run typecheck && npm run typecheck:scripts && npm run typecheck:tests
npm run build && npm run build:verify
npm audit --omit=dev
```

Mobile:

```bash
cd ugc-mobile && npm ci && npx patch-package && npm test && npm run typecheck && npx expo-doctor
```

Database (Supabase CLI pinned at 2.75.0):

```bash
npx supabase db reset --local && npx supabase test db
```

Production configuration (no values printed, ever):

```bash
npm run ops:external-gates                       # Supabase advisors + gate lints
npx --yes vercel@57.0.0 env ls production --format=json   # names only; diff against .env.example
```

- Schema parity: run `scripts/db/schema-fingerprint.sql` on production through the Supabase MCP and on a clean replay via the **Schema baseline** workflow; compare digests per object class.
- Dispatch `backend-alert-watchdog.yml` manually; it must be green.
- `PERF_ALLOW_PRODUCTION=1 npm run perf:load:smoke`.
- Latest `Quality`, `Production release`, and `Production Performance` runs on GitHub are green for the current `main`.

| Check | Result | Finding → section |
|---|---|---|
| Web gates | | |
| Mobile gates | | |
| Migration replay + pgTAP | | |
| Supabase advisors | | |
| Env names diff | | |
| Schema fingerprint parity | | |
| Watchdog manual run | | |
| Perf smoke | | |
| CI runs green | | |

Sign-off: —

---

## Section A — Money: credits, payments, payouts

**Why first:** a defect here costs real money or double-pays, and both clients
share one ledger.

**Scope (both surfaces):** `ai-usage-ledger.ts` hold/settle/refund; Razorpay
`order` / `verify` / `webhook`; mobile commerce `sync` / `restore` /
`revenuecat-webhook`; welcome credits and the claim ledger; referral link →
visit → claim → reward job; admin credit adjustments; creator payouts and
`CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY`; marketplace `order` / `verify` /
`unlock-with-credits`; resource-bundle `order` / `verify` / `unlock-free` /
`unlock-with-credits`; the pricing page and the mobile pricing tab copy against
the live catalog prices.

**Read:** the idempotency keys on settle and refund; the rule that a mobile IAP
writes both a `transactions` row and a `mobile_store_transactions` row (revenue
must exclude `mobile_product_id IS NOT NULL`); `profiles.credits` is the total,
never add `promotional_credits` to it; the welcome-credit gate on
`is_anonymous`.

**Run:**

```bash
npx vitest run src/__tests__/ai-usage-ledger* src/__tests__/*razorpay* src/__tests__/*revenuecat* src/__tests__/*welcome-credit* src/__tests__/*referral* src/__tests__/*payout* src/__tests__/*credit-rpc*
npx supabase test db   # payment_credit_ledger, cash_purchase_reconciliation, marketplace_unlock_ledger, ai_usage_credit_ledger, creator_payouts, admin_credit_adjustments
REVENUECAT_WEBHOOK_AUTH_TOKEN='Bearer ...' npm run ops:external-gates -- --probe-revenuecat-webhook
```

**Click (real money, smallest amounts):**

- Web: buy the cheapest pack with Razorpay live → balance moves once, one `transactions` row, admin revenue shows it once. Abandon a checkout → nothing credited.
- iOS sandbox and Android license-tester IAP → both rows written, admin revenue counts it **once**, Restore Purchases on a reinstall restores it. Then send the RevenueCat dashboard test webhook and find the `200` in Vercel logs.
- Start a generation that will fail (unsupported input) → credits refunded; start one that succeeds → settled once even if the completion poller and the webhook both fire.
- Guest tries to claim welcome credits → refused until handle and display name exist; a registered user claims once and cannot claim again after sign-out/in. (Memory note: the status endpoint once ignored `is_anonymous` — verify fixed.)
- Referral: link → visit → new account claims → reward appears after the `referral-reward-reconciliation` job.
- Seller requests a payout → admin payouts page shows it; the encrypted details round-trip.
- Buyer buys a bundle with credits and with cash; balance correct both times.

**Exit:** every money path has a ledger row you can point at; zero P0/P1 open.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section B — Identity, auth, accounts, admin access

**Scope:** OAuth-only policy (Google on web and Android, Apple on iOS);
anonymous guests; account merge (`/api/account/merge*`); account deletion
(content freeze, resweep cron, the half-deleted 409 state); session cookies;
`src/proxy.ts` gates (admin, mobile CORS allowlist from the contract, 426
version gate); `admin-auth.ts` as the real boundary; `e2e-auth.ts` build-blocked
in production; CSP currently report-only.

**Run:**

```bash
npx vitest run src/__tests__/auth-* src/__tests__/admin-* src/__tests__/mobile-cors-middleware* src/__tests__/server-helpers-authentication* src/__tests__/e2e-auth* src/__tests__/supabase-auth-*
npx supabase test db   # identity_state_deletion, guest_account_link, admin_sessions_security, client_rls_boundaries, anonymous_data_api_grants, account_deletion_*
npm run ops:external-gates
```

**External gates (runbook §External Dashboard Gates), each must be verified, not assumed:**

- Supabase: leaked-password protection on; Auth DB connections percentage-based; `external_anonymous_users_enabled` on (migration `20260811100000` landed first).
- Google Auth Platform: branding shows `Magicbooklet`, `magicbooklet.com` authorised, consent screen published; decide on the Supabase custom auth domain before a broad social-login push.
- Apple Sign In key (`APPLE_SIGN_IN_*`) valid and not near expiry.

**Click:**

- Fresh Google sign-in on web, Android, and iOS; Apple sign-in on iOS. The account chooser names Magicbooklet, not the Supabase project host.
- Guest creates something → signs in → merge keeps the creation and the credits rule holds.
- Delete account on web and on a phone → sign in again → clean state, no 409, no leftover public content (check the showcase, search, and the creator page).
- `/admin` and `/api/admin/*` unauthenticated → rejected at the edge **and** by the route; wrong password fails closed; a minted credential works.
- Mobile client below the minimum version → 426 → `update-required` screen; `/api/app-version` still answers.
- Signed-out curl against a private post, a private generation, and a paid bundle file URL → denied.

**Exit:** no path lets a guest act as a user; no half-deleted state; `ops:external-gates` green.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section C — Generation pipeline, provider, media

**Scope:** `/api/generate*`, `/api/generation-models/quote`,
`generation-services.ts`; the `kie-webhook` edge function and the HMAC
forward to `/api/webhooks/kie`; the completion and preview-repair crons; media
import through `MEDIA_IMPORT_HOST_ALLOWLIST` into Storage; posters and
previews; the database model catalog (`GENERATION_MODEL_CATALOG_SOURCE=database`
in production); `docs/model-api-references/` staleness; Kie balance and the
`BACKEND_BUDGET_*` thresholds; ffmpeg and sharp bundling.

**Run:**

```bash
npx vitest run src/__tests__/generation-* src/__tests__/*kie* src/__tests__/media-* src/__tests__/remote-media-security*
npx supabase test db   # generation_* suites, media_repair_leases
npm run ops:generation-model-catalog -- validate
npm run ops:generation-model-catalog -- diff      # against production
npm run build && npm run build:verify
```

**Click:** one real generation per model family (image, video, motion) on web and on each phone → lands in Creations with a poster; cancel/archive/restore works; a deliberate failure refunds; a duplicate provider callback (replay the webhook once from logs) settles once; Kie account balance covers a launch week and the low-balance alert path is understood.

**Known items to close here:**

- `build:verify` asserts only the ffmpeg half. Sharp's libvips has no build-time assertion and a green deploy once shipped without it (crons 500, scheduler stopped). Add a libvips assertion or a post-deploy probe of a sharp route.
- `vercel.json` declares three crons (`backend-jobs`, `generation-completions`, `media-preview-repair`); the runbook smoke test says "only `/api/cron/backend-jobs`" and `AGENTS.md` says one cron. Reconcile config and docs.
- `docs/model-api-references/veo-3-1.md` is known stale; verify every published model against docs.kie.ai before launch traffic.

**Exit:** each model family generated once per surface; failure refunds; catalog diff clean; the sharp gap closed.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section D — Content, social, search, moderation, safety compliance

**Scope:** posts (publish, edit, archive, restore), showcase feed and feed
events, threaded comments, follows, saves, remix, share, text posts, unified
search, notifications (web + mobile push), blocks, reports (post, comment,
user, generation), the admin moderation queue and history, `/child-safety`,
feed maintenance and retention jobs.

**Run:**

```bash
npx vitest run src/__tests__/showcase-* src/__tests__/post-* src/__tests__/*comment* src/__tests__/*search* src/__tests__/*moderation* src/__tests__/*notification*
npx supabase test db   # post_comments, feed_*, completed_post_remixes, operational_data_retention, admin_moderation_audit_integrity
npm run test:e2e -- public-search post-composer-media-reorder
```

**Click — the store-compliance loop (Apple 1.2 / Play UGC policy), on each surface with timestamps:**

- Report a post, a comment, and a user → the queue shows them → admin takes the post down → the reporter no longer sees it → the author sees the sanction.
- Block a user → their posts, comments, and profile vanish from feed, search, and notifications for the blocker.
- A guest browses: no private media, no archived posts in search, no edit affordances.
- Push: follow and comment on the phone accounts → notification arrives on iPhone and Android → tapping opens the right post → `mobile-push-receipts` job records delivery.
- Moderation roster from `docs/moderation-operations.md` is staffed and the queue SLA is realistic for one operator.

**Exit:** report → takedown proven on both surfaces; guest sees nothing private.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section E — Marketplace, bundles, templates, workflow builder (the paywall)

**Scope:** the field allowlist in `hydrateBundleRows`
(`src/lib/post-resource-bundles-server.ts`) — the paywall is app code, not
RLS; resource files sign/finalize; unlocks and `file-url`; marketplace assets,
import, verify, sales export; templates (create, validate, publish, disable,
test, runs); template runs (start, cancel, approval steps, retry); workflow
canvases (run, history, restore, publish, share, import, assistant); uploads
sign/finalize and the reclaim job.

**Run:**

```bash
npx vitest run src/__tests__/*paywall* src/__tests__/post-resource-bundle* src/__tests__/*marketplace* src/__tests__/template-* src/__tests__/workflow-*
npx supabase test db   # durable_viewer_unlock_security, marketplace_*, post_resource_bundle_*
npm run test:e2e -- workflow-builder
```

**Click:** Seller lists a paid bundle → Buyer sees the teaser only → **read the API JSON, not the UI**: no locked field present before purchase, `file-url` 403 → after purchase 200 and the file downloads on web and in the mobile unlocks screen. Free unlock path. Template publish → run on web and on a phone → approval step → retry a failed step. Workflow share → import into the Buyer account. Abandon an upload → the reclaim job cleans it without touching live media.

**Exit:** no unpurchased field leaks in any bundle response; every flow completed once per surface.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section F — Mobile release: binary, stores, OTA, device behaviour

**Scope:** the binary that will actually be in users' hands (0.1.3: iOS build 50, Android build 69, in review since 2026-09-04; `app.json` already says 0.1.4); `ota-targets.json` fingerprints; the R8 shape plugin; the 426 policy in `/api/app-version`; universal links contract; push token registration; IAP products in App Store Connect and Play (`docs/mobile-store-product-catalog.md` §Release gate); App Review demo account credits; the Play PairIP "Something went wrong" dialog toggle; HIG guard tests; haptics; gesture-handler being a native dependency.

**Run:**

```bash
cd ugc-mobile && npm test && npm run typecheck && npx expo-doctor
npx vitest run __tests__/hig-* __tests__/backend-boundary* __tests__/*contract-fixture*
node scripts/verify-ota-target.mjs      # against a real node_modules, not a symlink
```

**Click, on the exact store build (TestFlight / closed alpha), on real phones:**

- Cold start, guest browse, sign in, create, buy, post, comment, deep link from Safari/Chrome into the app, push notification tap, background → foreground after 10 minutes, airplane mode mid-upload, delete account.
- Android: system back on every screen (predictive-back), keyboard over sheets, the haptics from PR #92 (never yet felt on a phone), the PairIP dialog is off for the release.
- Store consoles: crash reports and vitals for the current live build; Play obfuscation score; screenshots match this build; age rating; App Privacy labels and Data safety form match what the app collects (push tokens, purchases, identifiers).
- Decide: ship 0.1.3 as submitted, or rebuild 0.1.4 with this audit's fixes. A JS-only fix can go OTA to the matching fingerprint; anything native needs a full build. Do not push to `main` while a store-release run is in flight.

**Exit:** device checklist signed per platform; `ota-targets.json` matches the shipped binaries; both apps approved.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section G — Web public surface: SEO, legal, landing pages, caching, headers

**Scope:** `/`, the `/ai-*` landing pages, `/pricing`, `/blog`, `/templates`,
`/marketplace`, `/showcase`; legal and policy pages (`/privacy`, `/terms`,
`/cancellation`, `/child-safety`, `/contact`, `/delete-account`); `robots.ts`,
`sitemap.ts`, `opengraph-image.png`, `icon.png`; GA and the Speed Insights
flag; security headers and the report-only CSP; the public/private cache
contract; the signed-in rewrites of `/`, `/feed`, `/showcase`, `/marketplace`;
404 and error pages; `NEXT_PUBLIC_BUSINESS_ADDRESS` and
`NEXT_PUBLIC_SUPPORT_PHONE` (Razorpay merchant policy); store badge URLs.

**Run:**

```bash
LHCI_FORM_FACTOR=mobile PERF_LIGHTHOUSE_RUNS=1 npm run perf:lighthouse
curl -sS -D - -o /dev/null 'https://magicbooklet.com/api/generation-models?platform=web&schemaVersion=1'   # public cache
curl -sS -D - -o /dev/null https://magicbooklet.com/api/ops/backend-health                                 # private, 401, no-store
curl -sS https://magicbooklet.com/sitemap.xml | grep -oE '<loc>[^<]+' | sed 's/<loc>//' | xargs -n1 -I{} sh -c 'printf "%s " {}; curl -s -o /dev/null -w "%{http_code}\n" {}'
```

**Click (signed out, desktop and mobile Safari):** every page in scope in light and dark theme; OG preview in a share debugger; read each legal page for accuracy (entity name, address, refund terms versus what `/cancellation` actually does, child-safety contact address set); the CSP report volume at `/api/security/csp-report` before deciding whether to enforce; signed-in `/` rewrites to `/home` without a flash.

**Exit:** Lighthouse budgets in `config/performance-budgets.json` met; no non-200 in the sitemap; legal pages reviewed and dated.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section H — Database, infrastructure, backups, capacity

**Scope:** migration ledger parity; RLS and grants (append-only tables revoke
`UPDATE, DELETE` from `service_role`); advisors (the workflow-canvas RPC
warnings are verified false positives); Supabase plan settings: spend cap,
PITR (none), Storage backup (none), egress; Vercel: Fluid, `bom1`, Node 24,
env contract complete; GitHub `production` environment protections; Vercel
Git auto-deploy off; secret hygiene.

**Run:**

```bash
npm run db:inspect:performance
npm run ops:external-gates
npx --yes vercel@57.0.0 env ls production --format=json     # names only, diff against .env.example
```

- Schema fingerprint parity (Phase 0 result) resolved.
- Supabase usage page: egress, MAU, DB size, Storage size, connection count. Egress is the known scaling wall (viewers stream full MP4s; roughly 300–500 MAU on the current plan). Write the number and the trigger to act on it into this section.
- Scaling findings S1, S2, S3, S5, S6, S7 in `docs/audits/scaling-findings-2026-08-22.md` still read "measurement required" or "revalidate". Either measure them now or record explicitly that launch proceeds without the measurement.
- Rotate any secret that has ever appeared in a transcript or a log. Never rotate `ACCOUNT_IDENTITY_FINGERPRINT_SECRET` or `REFERRAL_ATTRIBUTION_HASH_SECRET` (they HMAC stored rows).
- Decide PITR and Storage backup (Decisions table).

**Exit:** fingerprints match; env diff empty; capacity ceiling and its trigger written down.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Section I — Observability, alerts, incident readiness

**Why last (but before go-live):** it must watch the final build, and the
runbook itself says a launch sign-off must link a green manual watchdog run.

**Scope:** watchdog activation (`OPS_READ_SECRET` in GitHub Actions secrets);
`/api/ops/backend-alerts` degraded conditions; `BACKEND_BUDGET_*` values;
`BACKEND_ALERT_DELIVERY_URL` (unset — a free Discord/Slack webhook would give
faster-than-hourly alerts); Sentry on web (`@sentry/nextjs`, DSN present in
production, source maps uploading); **no crash reporting on mobile at all**
(no Sentry in `ugc-mobile`); log capture before Vercel retention expires;
rollback rehearsal; the weekly review cadence.

**Run / do:**

- Dispatch the watchdog manually and link the green run here.
- Trigger a test exception on web and find it in Sentry with a readable stack.
- Rehearse application rollback once (runbook §Rollback) on a staged deployment.
- Confirm the `backend-alert-delivery` job reports `skipped` with `alert_delivery_not_configured` and decide whether to set a webhook.
- Write the incident card: where logs are, their retention window, who acts, how to contain provider spend.

**Known drift to fix here:**

- Runbook §Accepted blind spots says "No mobile OTA channel". OTA has been live since 0.1.2 with fingerprint targets; update the runbook.
- Runbook §Build And Region smoke says the cron list must contain only `backend-jobs`; see Section C.
- Memory note: a watchdog `503` once traced to an upload-reclaim sweep defect (retention draining reservations). Confirm the fix is in the live build via `/api/app-version` and a clean `backend-health`.

**Exit:** watchdog run linked; Sentry event seen; rollback rehearsed; incident card written.

| # | Finding | Severity | Status / PR |
|---|---|---|---|
| | | | |

Sign-off: —

---

## Final — Release rehearsal and go-live

1. All section PRs merged; `main` clean; `Quality` green on the final SHA.
2. `Production release` runs for that SHA; runbook §Post-Deployment Smoke Tests completed; `/api/app-version` reports the SHA.
3. Monitor one full scheduler interval (10 minutes) plus the next hourly watchdog run.
4. Stores: promote Android alpha → production and submit iOS for review (console recipe in memory: Play promote → save → submit change; ASC new version → build → Add for Review → Submit). Do not push to `main` until the store-release run has passed its submit gate.
5. Set `ota-targets.json` to the shipped binaries in the same commit as the release notes.
6. First week: the runbook's weekly review, daily for the first seven days.

Sign-off: —

---

## Seed findings (from mapping the codebase on 2026-09-05)

| # | Finding | Section | Severity (provisional) |
|---|---|---|---|
| S-1 | `vercel.json` has three crons; runbook and `AGENTS.md` say one | C / I | P2 (doc/config drift) |
| S-2 | Runbook blind-spots list says no mobile OTA channel; OTA is live | I | P3 (stale doc) |
| S-3 | `build:verify` asserts ffmpeg only; sharp/libvips unverified at build time | C | P1 (a green deploy once shipped broken media routes) |
| S-4 | Mobile has no crash or error reporting | I / F | Decision |
| S-5 | Scaling findings S1–S3, S5–S7 still "measurement required" | H | Decision |
| S-6 | Android haptics change (PR #92) never verified on a real phone | F | P2 until felt |
| S-7 | External auth/payment gates not verified in this session (leaked-password, pool %, Google branding, RevenueCat test webhook, watchdog secret) | B / A / I | Unknown until run |
| S-8 | Welcome-credit status endpoint once ignored `is_anonymous` — confirm fixed | A | Unknown until run |
