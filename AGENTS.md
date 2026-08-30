# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Codex, and others) when working with code in this repository. `CLAUDE.md` is a symlink to this file — both names are the same file.

## What this is

Magicbooklet — an AI UGC creation platform: image/video/motion generation (provider: Kie.ai), a public showcase feed with a social layer (threaded comments, text posts, follows, saves, post overlay), a creator marketplace with paid resource bundles, templates, and a node-based workflow builder. Product direction: a community around AI media creation, expanding later into the broader marketing space.

- **Web + API**: Next.js 16 App Router (React 19, Tailwind v4) on Vercel, region `bom1`, production domain `magicbooklet.com`, branch `main`.
- **Backend of record**: Supabase (Postgres 17, Auth, Storage, RLS, atomic RPCs). Exactly one Deno edge function: `supabase/functions/kie-webhook`.
- **Mobile**: Expo SDK 55 + expo-router app in `ugc-mobile/` — a fully separate npm workspace (own lockfile, node_modules, vitest, tsconfig). Excluded from the web app's lint/typecheck/build.

Node 24 (`.nvmrc`). Payments: Razorpay (web, INR-first) and RevenueCat (mobile IAP).

## Commands

Web app (repo root):

```bash
npm run dev                # dev server on :3000 (webpack; `npm run dev:turbo` for Turbopack)
npm run build              # production build
npm run build:verify       # assert ffmpeg is resolvable at runtime in the media routes
npm run lint               # eslint (ugc-mobile is ignored)
npm run typecheck          # app only — excludes scripts/, src/__tests__/, ugc-mobile/
npm run typecheck:scripts  # separate project for scripts/ (tsconfig.scripts.json)
npm run typecheck:tests    # separate project for src/__tests__/ (tsconfig.tests.json)
npm test                   # vitest run — all unit/integration tests in src/__tests__/
npx vitest run src/__tests__/<file>.test.ts   # single test file
npm run test:e2e           # Playwright, tests/e2e/ — boots its own dev server on :3100 with E2E auth bypass
# also available: backfill:* (media/preview backfills) and perf:load / perf:lighthouse harnesses
```

Mobile app:

```bash
cd ugc-mobile
npm test                   # vitest run — tests in __tests__/
npx vitest run __tests__/<file>.test.ts
npm run typecheck
npm run ios | android | start
```

Database (local stack requires Docker):

```bash
npx supabase start             # local API :54321, DB :54322, Studio :54323
npx supabase db reset --local  # replay all migrations from clean (must always pass)
npx supabase test db           # pgTAP tests in supabase/tests/database/
npm run db:migrations:check    # fail on local/linked migration drift
```

Ops CLIs (service-role; read-only unless `--apply`/`--confirm` given):

```bash
npm run ops:moderation -- list
npm run ops:generation-model-catalog -- validate|diff|stage|publish|rollback ...
npm run admin:credentials              # mint the /admin master credential (prints the password once)
npm run ops:external-gates             # verify prod external config (Supabase auth lints, RevenueCat webhook)
```

CI (`.github/workflows/quality.yml`) gates PRs with: web `test → lint → typecheck → typecheck:scripts → typecheck:tests → perf self-tests → build → build:verify`; mobile `expo install --check → expo-doctor → expo prebuild --clean → expo export → test → typecheck`; and a full migration replay from a clean database plus `supabase test db` (Supabase CLI pinned to 2.75.0). Quality also runs a Playwright E2E smoke job. Sibling workflows: `production-release.yml` (production deploys — see Deploys), `performance.yml`, `backend-alert-watchdog.yml`, `mobile-store-release.yml`.

## Local environment

`.env.local` is hand-toggled between local and production Supabase by commenting/uncommenting the key blocks — **check which one is active before running the dev server** so you don't develop against production. Reference URLs and the toggle procedure: `.agent/workflows/local.md`. Full variable reference: `.env.example`. `GENERATION_MODEL_CATALOG_SOURCE` is `code` for local/test, `database` in production.

## Architecture

### One backend, two clients

Vercel API routes are the business-logic boundary for both web and mobile. Supabase is the source of truth for auth, data, storage, RLS, atomic RPCs, and job locks. Clients never own pricing, provider routing, credit settlement, payment trust, or generation validation. `ugc-mobile/__tests__/backend-boundary.test.ts` enforces this on the mobile side.

### Route → adapter → service layering

`src/lib` is flat (~360 files); naming is the organization, with three layers:

1. `src/app/api/**/route.ts` — 2–8 line shells, e.g. `export const { GET, POST } = createPostsRouteHandlers();`
2. `src/lib/*-route-adapter-service.ts` — HTTP concerns: parsing, auth, rate limits, responses.
3. `src/lib/*-service.ts` and bare domain modules — business logic, heavily unit-tested.

A new endpoint means a new adapter in `src/lib` plus a thin `route.ts`. Orientation points: `generation-services.ts` (generation hub), `workflow-canvas.ts` (largest file, workflow graph types/validation), `showcase-feed.ts`, `post-resource-bundles-server.ts`, `ai-usage-ledger.ts` (idempotent credit start/settle/refund), `backend-jobs.ts` (job registry).

### Supabase client creation — pick the right one

| Context | Use |
|---|---|
| Browser | `src/lib/supabase.ts` singleton |
| Server Components / RSC | `getServerAuthState()` / clients from `src/lib/supabase-server.ts` (cookie-based, `server-only`) |
| Privileged (webhooks, cron, ops) | `createServiceClient()` from `src/lib/server-helpers.ts` |
| API routes on behalf of a mobile user | `createUserClient(request)` from `src/lib/server-helpers.ts` (forwards the JWT) |

### Generation pipeline

Start services validate against the model catalog, quote credits, and place a ledger hold → provider (Kie.ai) task created → provider callbacks hit the Supabase edge function `kie-webhook`, which HMAC-signs and forwards to `/api/webhooks/kie` (callbacks never hit Vercel directly) → outputs are imported from allowlisted provider hosts (`MEDIA_IMPORT_HOST_ALLOWLIST`) into Supabase Storage → credits settle or refund idempotently. `ffmpeg-static` is force-bundled into the media-touching routes via `outputFileTracingIncludes` in `next.config.ts`; `npm run build:verify` asserts it.

### Generation model catalog (control plane)

Production model definitions, controls, and pricing live in Supabase, released through a revision-guarded workflow: manifests in `config/generation-model-catalog/releases/` are validated → diffed → staged as an immutable `shadow` release → verified → published atomically via `scripts/generation-model-catalog.ts`. Clients read only the public projection via `/api/generation-models`. `src/lib/models.ts` is the legacy static catalog (`GENERATION_MODEL_CATALOG_SOURCE=code` fallback). Runbook: `docs/generation-model-catalog-operations.md`. New model API references live in `model_api_references/`.

### Web ↔ mobile contract

`contracts/mobile-api-operations-v1.json` is consumed **at runtime** by `src/proxy.ts` (Next middleware) to build the mobile CORS allowlist; `proxy.ts` also enforces mobile client version gating (HTTP 426 with upgrade policy, `/api/app-version` exempt). `contracts/mobile-api-v1.json` and `generation-model-catalog-v1.json` are shared test fixtures imported by both `src/__tests__` and `ugc-mobile/__tests__`, so a breaking API change fails tests on both sides. Changing a mobile-facing route means updating the contract files and both test suites.

### Admin console (`/admin`)

A browser-only operator console living in the same Next.js app under the
`src/app/admin/(console)/` route group; `/admin/login` sits outside the group so
it renders without the console chrome. Areas: overview (reuses the
`/api/ops/*` collectors), moderation queue, users & credits, revenue, content,
system.

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
- Revenue reporting must exclude `transactions.mobile_product_id IS NOT NULL`:
  a mobile IAP writes **both** a `transactions` row and a
  `mobile_store_transactions` row (linked by `source_record_id`), so counting
  `transactions` wholesale double-counts every mobile purchase.

### Background jobs

One Vercel cron (`/api/cron/backend-jobs`, every 10 min, `CRON_SECRET` bearer auth) dispatches the job registry in `src/lib/backend-jobs.ts` (completion polling, media preview repair, feed maintenance, push receipts, referral rewards, alert delivery) under DB job locks with a daily invocation budget. Read-only ops dashboards live under `/api/ops/*` behind `OPS_READ_SECRET`.

### Tests

All web unit/integration tests live flat in `src/__tests__/` (~540 files) — never colocated. Notable conventions: `*-migration.test.ts` files assert the SQL content of migrations (add one when you add a migration); contract fixture tests pin the mobile API. E2E lives in `tests/e2e/` and uses an auth bypass (`src/lib/e2e-auth.ts`) that is build-blocked in production. Mobile logic is factored into `ugc-mobile/lib/*-view-model.ts` modules precisely so it can be vitest-tested without rendering.

Three E2E gotchas worth knowing before you debug one:

- **Playwright's own dev server refuses to start if another `next dev` is already running**, even on a different port, and the failure reads as a config error. Stop any preview/dev server (including one started via `preview_start`) before `npm run test:e2e`.
- **The auth bypass needs its cookie, not just the env vars.** A spec that only visits an authenticated route lands on `/login`; add `{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }` via `context.addCookies` first (see the existing specs).
- **The dev server reloads open pages behind your back.** `next dev` full-reloads every connected page when Fast Refresh cannot hot-apply an update, and both Playwright workers share one dev server that compiles routes on demand — a parked page self-reloads several times a minute on a cold `.next`. A self-reload landing in the same tick as a spec's own navigation cancels it, surfacing as `net::ERR_ABORTED; maybe frame was detached?`. `tests/e2e/kling-o3-named-subjects.spec.ts` carries the retry helper for it.

## Conventions and cautions

- **Bug fixes — reproduce first, at the layer the bug actually lives**: pure logic (`src/lib/*-service.ts`, `ugc-mobile/lib/*-view-model.ts`) reproduces as a failing vitest case — write it before the fix and keep it as the regression test. Rendering, navigation, native-module, and provider-callback bugs do **not** reproduce in vitest: use `npm run test:e2e` (web) or a booted simulator/emulator (mobile has no E2E harness). Never call one of those fixed on unit-test evidence, or on a dependency bump that merely appears to help — confirm on the surface the bug was reported on. If you cannot reproduce it at all, stop and report: state what you ruled out and what evidence would confirm the cause. Never ship a speculative fix in place of a reproduction.
- **Migrations**: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`. Capture changes with `supabase db diff --local --schema public,storage,auth -f name`, verify with `db reset --local`. Never edit an applied migration. Workflow: `docs/supabase-local-prod-workflow.md`.
  - **The CLI cannot reach production from a developer machine** — neither the direct nor the pooler endpoint answers — so `db push --dry-run --linked` and `migration list --linked` (and therefore `npm run db:migrations:check`) do not work against prod. Ask the parity question with `scripts/schema-fingerprint.sql` instead: run it on production through the Supabase MCP / Management API and on a clean replay via the **Schema baseline** workflow, then compare digests per object class.
  - Production's ledger is what a **preview branch** replays, not these files, so the two must agree. `repair-migration-ledger.yml` (`report` / `apply` / `verify`) rewrites every `supabase_migrations.schema_migrations` row from its file. Run it only from `main` and only **after** the matching commit is pushed — repairing first makes the next release read the repository's own history as pending. `supabase-migration-ledger-ordering.test.ts` pins that rule.
  - Applying DDL to production outside these files leaves the ledger unable to rebuild the database: `supabase migration repair` records a version and a name with **no statements**, which is what broke branching (audit *Finding C*).
- **Deploys**: `.github/workflows/production-release.yml` owns production releases after the exact `main` SHA passes Quality. It applies Supabase migrations and the Edge Function, stages a production-configured Vercel deployment without domains, verifies public and authenticated health, rejects stale SHAs, then promotes and verifies the live SHA. Vercel Git integration may create previews but must not auto-promote production. Manual `vercel --prod` is recovery-only. Pre-deploy gates and env contract: `docs/production-deployment-runbook.md`.
- **Stale docs**: `.agent/workflows/integrate-model.md` describes the old per-page model registries — superseded by the database catalog workflow above. `.agent/workflows/publish.md` is superseded by the production-release workflow; its body now just redirects there. The root `README.md` is untouched create-next-app boilerplate. `design-web.md` and `design-mobile.md` predate the 2026-07 feed/comments/text-posts overhaul — trust tokens and primitives, but verify page patterns against current code (see the note in `design.md`).
- **Mobile UI is held to Apple's HIG**: check visual and layout changes in `ugc-mobile/` against the Human Interface Guidelines before shipping them. The numeric floors are enforced by `ugc-mobile/__tests__/hig-type-and-contrast.test.ts` — 11pt minimum type, 4.5:1 body contrast on every panel surface, 44pt hit regions (geometry in `ugc-mobile/lib/hit-target.ts`) — so a red guard is a real violation: fix the control, never the threshold. Adopting a further HIG rule means extending those guard tests so every later screen inherits it, not fixing one instance. Reading the guidelines: the HIG pages (developer.apple.com/design/human-interface-guidelines) are client-rendered, so a plain fetch returns only the page title — but the full text of any page is plain JSON at `developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json` (curl works), and a rendering browser reads the pages normally. developer.apple.com/design/tips/ is a static one-page summary of the key numbers. Note the full HIG carries nuance the summary lacks — e.g. 44×44pt is the *default* control size on iOS; 28×28pt is the absolute floor.
- **Design**: start at `design.md`, which indexes `design-web.md` (web) and `design-mobile.md` (mobile). North star: premium dark AI creator studio — shared tokens, Lucide icons, strict spacing, reusable primitives. Shared web UI lives in `src/app/components/` (not a route).
- **Path aliases differ**: web `@/*` → `src/*`; mobile `@/*` → `ugc-mobile/*` root.
- **CSS split**: `globals.css` is public-route CSS; authenticated surfaces add `non-public-utilities.css` via their route layouts (CSS is inlined via `experimental.inlineCss`).
- **Secrets**: the service-role key exists only in trusted server/operator environments — never in manifests, client bundles, command output, or committed files. Ops CLIs deliberately redact provider mappings and prices.
- **Blog content** is markdown in `content/blog/*.md` rendered via `src/lib/blog.ts`.

## Operational runbooks (`docs/`)

`production-deployment-runbook.md` (topology, env contract, gates), `supabase-local-prod-workflow.md`, `generation-model-catalog-operations.md`, `moderation-operations.md` (staffed queue, service-role CLI), `mobile-store-product-catalog.md` (IAP tier provisioning), and `post-resource-bundle-v1.md`. Dated research snapshots (`performance-audit-2026-07-16.md`, `ui-consistency-research-2026-06-14.md`) and agent plans/specs (`docs/superpowers/`) sit alongside the runbooks. `scaling-audit.md` is the active scaling entry point; it links the current finding set and exact-build certificates. Dated audit journals live under `docs/archive/` and must not be treated as current capacity claims.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
