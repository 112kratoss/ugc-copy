# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Magicbooklet — an AI UGC creation platform: image/video/motion generation (provider: Kie.ai), a public showcase feed, a creator marketplace with paid resource bundles, templates, and a node-based workflow builder.

- **Web + API**: Next.js 16 App Router (React 19, Tailwind v4) on Vercel, region `bom1`, production domain `magicbooklet.com`, branch `main`.
- **Backend of record**: Supabase (Postgres 17, Auth, Storage, RLS, atomic RPCs). Exactly one Deno edge function: `supabase/functions/kie-webhook`.
- **Mobile**: Expo SDK 55 + expo-router app in `ugc-mobile/` — a fully separate npm workspace (own lockfile, node_modules, vitest, tsconfig). Excluded from the web app's lint/typecheck/build.

Node 24 (`.nvmrc`). Payments: Razorpay (web, INR-first) and RevenueCat (mobile IAP).

## Commands

Web app (repo root):

```bash
npm run dev                # dev server on :3000 (webpack; `npm run dev:turbo` for Turbopack)
npm run build              # production build
npm run build:verify       # assert ffmpeg-static actually got bundled into media routes
npm run lint               # eslint (ugc-mobile is ignored)
npm run typecheck          # app only — excludes scripts/, src/__tests__/, ugc-mobile/
npm run typecheck:scripts  # separate project for scripts/ (tsconfig.scripts.json)
npm test                   # vitest run — all unit/integration tests in src/__tests__/
npx vitest run src/__tests__/<file>.test.ts   # single test file
npm run test:e2e           # Playwright, tests/e2e/ — boots its own dev server on :3100 with E2E auth bypass
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
```

CI (`.github/workflows/quality.yml`) gates PRs with: web `test → lint → typecheck → typecheck:scripts → perf self-tests → build → build:verify`; mobile `expo install --check → expo-doctor → expo prebuild --clean → expo export → test → typecheck`; and a full migration replay from a clean database plus `supabase test db` (Supabase CLI pinned to 2.75.0).

## Local environment

`.env.local` is hand-toggled between local and production Supabase by commenting/uncommenting the key blocks — **check which one is active before running the dev server** so you don't develop against production. Reference URLs and the toggle procedure: `.agent/workflows/local.md`. Full variable reference: `.env.example`. `GENERATION_MODEL_CATALOG_SOURCE` is `code` for local/test, `database` in production.

## Architecture

### One backend, two clients

Vercel API routes are the business-logic boundary for both web and mobile. Supabase is the source of truth for auth, data, storage, RLS, atomic RPCs, and job locks. Clients never own pricing, provider routing, credit settlement, payment trust, or generation validation. `ugc-mobile/__tests__/backend-boundary.test.ts` enforces this on the mobile side.

### Route → adapter → service layering

`src/lib` is flat (~290 files); naming is the organization, with three layers:

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

### Background jobs

One Vercel cron (`/api/cron/backend-jobs`, every 10 min, `CRON_SECRET` bearer auth) dispatches the job registry in `src/lib/backend-jobs.ts` (completion polling, media preview repair, feed maintenance, push receipts, referral rewards, alert delivery) under DB job locks with a daily invocation budget. Read-only ops dashboards live under `/api/ops/*` behind `OPS_READ_SECRET`.

### Tests

All web unit/integration tests live flat in `src/__tests__/` (~480 files) — never colocated. Notable conventions: `*-migration.test.ts` files assert the SQL content of migrations (add one when you add a migration); contract fixture tests pin the mobile API. E2E lives in `tests/e2e/` and uses an auth bypass (`src/lib/e2e-auth.ts`) that is build-blocked in production. Mobile logic is factored into `ugc-mobile/lib/*-view-model.ts` modules precisely so it can be vitest-tested without rendering.

## Conventions and cautions

- **Migrations**: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`. Capture changes with `supabase db diff --local --schema public,storage,auth -f name`, verify with `db reset --local`, preview prod with `db push --dry-run --linked`. Never edit an applied migration. Workflow: `docs/supabase-local-prod-workflow.md`.
- **Deploys**: Vercel Git integration owns production deploys from `main`. Do **not** run `vercel --prod` for a commit Git will deploy (`.agent/workflows/publish.md` predates this rule and is stale). Pre-deploy gates and env contract: `docs/production-deployment-runbook.md`.
- **Stale docs**: `.agent/workflows/integrate-model.md` describes the old per-page model registries — superseded by the database catalog workflow above. The root `README.md` is untouched create-next-app boilerplate.
- **Design**: start at `design.md`, which indexes `design-web.md` (web) and `design-mobile.md` (mobile). North star: premium dark AI creator studio — shared tokens, Lucide icons, strict spacing, reusable primitives. Shared web UI lives in `src/app/components/` (not a route).
- **Path aliases differ**: web `@/*` → `src/*`; mobile `@/*` → `ugc-mobile/*` root.
- **CSS split**: `globals.css` is public-route CSS; authenticated surfaces add `non-public-utilities.css` via their route layouts (CSS is inlined via `experimental.inlineCss`).
- **Secrets**: the service-role key exists only in trusted server/operator environments — never in manifests, client bundles, command output, or committed files. Ops CLIs deliberately redact provider mappings and prices.
- **Blog content** is markdown in `content/blog/*.md` rendered via `src/lib/blog.ts`.

## Operational runbooks (`docs/`)

`production-deployment-runbook.md` (topology, env contract, gates), `supabase-local-prod-workflow.md`, `generation-model-catalog-operations.md`, `moderation-operations.md` (staffed queue, service-role CLI), `mobile-store-product-catalog.md` (IAP tier provisioning), `post-resource-bundle-v1.md`, and `backend-idealization-progress.md` (live backend completion tracker + architectural history; its displayed counts are enforced by `src/__tests__/backend-idealization-progress.test.ts`, so update the Overall Progress block whenever checklist items change).
