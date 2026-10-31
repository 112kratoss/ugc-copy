# AGENTS.md

This file provides guidance to AI coding agents (Claude Code and others) when working with code in this repository. Claude Code reads it directly, so there is no `CLAUDE.md` — don't add one, and no `CLAUDE.local.md` or `.claude/CLAUDE.md` either: any of the three at or above the working directory makes Claude Code read those instead and skip this file.

## What this is

Magicbooklet — an AI UGC creation platform: image/video/motion generation (provider: Kie.ai), a public showcase feed with a social layer (threaded comments, text posts, follows, saves, post overlay), unified public search, a creator marketplace with paid resource bundles, templates, and a node-based workflow builder. Product direction: a community around AI media creation, expanding later into the broader marketing space.

- **Web + API**: Next.js 16 App Router (React 19, Tailwind v4) on Vercel, region `bom1`, production domain `magicbooklet.com`, branch `main`.
- **Backend of record**: Supabase (Postgres 17, Auth, Storage, RLS, atomic RPCs). Two Deno edge functions: `kie-webhook` and `embed-post` (`supabase/functions/`).
- **Mobile**: Expo SDK 55 + expo-router app in `ugc-mobile/` — a fully separate npm workspace (own lockfile, node_modules, vitest, tsconfig). Excluded from the web app's lint/typecheck/build.

Node 24 (`.nvmrc`). Payments: Razorpay (web, INR-first) and RevenueCat (mobile IAP).

## Commands

Web app (repo root):

```bash
npm run dev                # dev server on :3000 (webpack; `npm run dev:turbo` for Turbopack)
npm run build              # production build — never while a dev server runs (they share .next)
npm run build:verify       # assert ffmpeg is resolvable at runtime in the media routes
npm run lint               # eslint (ugc-mobile is ignored)
npm run typecheck          # app only — excludes scripts/, src/__tests__/, ugc-mobile/
npm run typecheck:scripts  # separate project for scripts/ (tsconfig.scripts.json)
npm run typecheck:tests    # separate project for src/__tests__/ (tsconfig.tests.json)
npm test                   # vitest run — all unit/integration tests in src/__tests__/
npm run test:quiet         # the same suite with the dot reporter and output only from failing tests (agents, long sessions)
npx vitest run src/__tests__/<file>.test.ts   # single test file
npm run test:e2e           # Playwright, tests/e2e/ — boots its own dev server on :3100 with E2E auth bypass and the config's placeholder env only (no app variable from the shell, no .env file of the checkout)
# also available: backfill:* (media/preview/fingerprint backfills), perf:load / perf:lighthouse,
# db:inspect:performance, db:benchmark:scaling, eval:enhancer (prompt-enhancer eval), ops:guest-acceptance
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
npx supabase start             # local API :54321, DB :54322, Studio :54323 — on the dev Mac pin the CLI at 2.75.0 (npx --yes supabase@2.75.0 …); newer versions hang silently on start there
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

CI (`.github/workflows/quality.yml`) gates PRs with: web `test → four media audits (scripts/audits/: staging locks, scratch reclamation and encoder output bounds with the real FFmpeg, then cross-process staging admission) → lint → typecheck → typecheck:scripts → typecheck:tests → perf self-tests → build → build:verify`; mobile `expo install --check → expo-doctor` (both offline, `EXPO_OFFLINE=1`; Expo's live list gates only a PR that changes the app's version, and is a report on main's runs: `ugc-mobile/__tests__/expo-install-exclude.test.ts` says why) `→ fingerprint against ota-targets.json (advisory) → release-env:self-test → expo prebuild --clean → expo export → test → typecheck`; and two Supabase jobs: an API integration job (an isolated local stack with real Auth, Storage and PostgREST for the account-deletion, ops-ingress, admin-collector and signup-collision vitest configs) and a full migration replay from a clean database plus `supabase test db` (Supabase CLI pinned to 2.109.1 in the workflow — the 2.75.0 pin above is for the dev Mac only). Quality also runs a Playwright E2E smoke job. Sibling workflows: `production-release.yml` (production deploys) and `mobile-store-release.yml` (store binaries + OTA) — both covered under Deploys — plus `performance.yml`, `backend-alert-watchdog.yml`, `schema-baseline.yml`, and `repair-migration-ledger.yml`.

## Local environment

`.env.local` is hand-toggled between local and production Supabase by commenting/uncommenting the key blocks — **check which one is active before running the dev server** so you don't develop against production. Reference URLs and the toggle procedure: `docs/local-development.md`. Full variable reference: `.env.example`, which lists every `process.env` name the app reads (`e2e-smoke-readiness.test.ts` fails on one it does not, because the E2E server unsets exactly that list). `GENERATION_MODEL_CATALOG_SOURCE` is `code` for local/test, `database` in production.

## Architecture

### One backend, two clients

Vercel API routes are the business-logic boundary for both web and mobile. Supabase is the source of truth for auth, data, storage, RLS, atomic RPCs, and job locks. Clients never own pricing, provider routing, credit settlement, payment trust, or generation validation. `ugc-mobile/__tests__/backend-boundary.test.ts` enforces this on the mobile side.

### Route → adapter → service layering

`src/lib` is flat (~570 files); naming is the organization, with three layers:

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

Start services validate against the model catalog, quote credits, and place a ledger hold → provider (Kie.ai) task created → provider callbacks hit the Supabase edge function `kie-webhook`, which HMAC-signs and forwards to `/api/webhooks/kie` (callbacks never hit Vercel directly) → outputs are imported from allowlisted provider hosts (`MEDIA_IMPORT_HOST_ALLOWLIST`) into Supabase Storage → credits settle or refund idempotently. `ffmpeg-static` and sharp's native libvips (`@img/sharp-libvips-*`) are force-bundled into the media-touching routes via `outputFileTracingIncludes` in `next.config.ts` — externalizing alone does not trace them, and a green build can otherwise ship without the binaries and 500 at runtime; `npm run build:verify` asserts the ffmpeg half.

### Generation model catalog (control plane)

Production model definitions, controls, and pricing live in Supabase, released through a revision-guarded workflow: manifests in `config/generation-model-catalog/releases/` are validated → diffed → staged as an immutable `shadow` release → verified → published atomically via `scripts/ops/generation-model-catalog.ts`. Clients read only the public projection: the web and mobile creators page it through `/api/model-catalog/v1` (`platform=web|mobile`; current revision → summaries → per-model descriptors, runbook section "Scalable public transport"), and `/api/generation-models` stays for installed clients. `src/lib/models.ts` is the legacy static catalog (`GENERATION_MODEL_CATALOG_SOURCE=code` fallback). Runbook: `docs/generation-model-catalog-operations.md`. Adding a model end to end (provider checks, where it registers in code, emitting and pinning its release, code deployed before the release is published) is `docs/model-onboarding.md`, which the `add-generation-model` skill in `.agents/skills/` (symlinked into `.claude/skills/`) loads. New model API references live in `docs/model-api-references/`.

### Web ↔ mobile contract

`contracts/` holds sixteen versioned JSON contracts: five are read at runtime (the mobile CORS allowlist, universal links, resource-bundle authoring, credit packs, reserved handles) and eleven are fixtures imported by both `src/__tests__` and `ugc-mobile/__tests__`, so a breaking API change fails tests on both sides. Changing a mobile-facing route means updating the contract files and both suites. Four catalog modules under `ugc-mobile/lib/model-catalog/`, the saver notice's policy (`ugc-mobile/lib/saver-notice-policy/`), the post publish policy (`ugc-mobile/lib/post-publish-policy/`: the placeholder-title rule the server and both composers apply, the title suggested for a creation, the handle suggested to a new creator), the video and motion creators' settings chip (`ugc-mobile/lib/creator-settings-summary/`), the creators' fitting rule (`ugc-mobile/lib/creator-run-fit/`: the settings a model opens on, the model list split by the balance, the model a remix opens on when the balance is short) how an unlocked recipe reads (`ugc-mobile/lib/recipe-reading/`: the order and names of its groups on the post page, the reel, the library and the app's Details) and the model and settings each app creator opens on before its catalog arrives (`ugc-mobile/lib/app-creator-opening/`, held to the code catalog by `src/__tests__/app-creator-opening.test.ts`), and the signed resumable (TUS) upload transport (`ugc-mobile/lib/media-upload/`) are shared with the web by relative import and must stay free of React Native, Expo and Node imports. `src/proxy.ts` is the bearer admission boundary for every policy-listed `/api` route (`src/lib/route-identity-policy.ts`), with two guest exception lists, and `/api/showcase/feed` runs the same check at the route itself. The full contract, deep-link and admission rules are `.claude/rules/web-mobile-contract.md`, loaded when those files are touched; read it before changing any of them.

### Admin console (`/admin`)

A browser-only operator console under `src/app/admin/(console)/`, gated twice (an edge check in `src/proxy.ts`, the route check in `admin-auth.ts`) behind a single master operator credential minted with `npm run admin:credentials`. The credential format, the credit-adjustment policy and the revenue double-count rule are `.claude/rules/admin-console.md`, loaded with the admin files.

### Background jobs

Three Vercel crons run every 10 min under `CRON_SECRET` bearer auth: `/api/cron/backend-jobs` dispatches the job registry in `src/lib/backend-jobs.ts` (completion polling, media preview repair, feed maintenance, push receipts, referral rewards, alert delivery) under DB job locks with a daily invocation budget, and `/api/cron/generation-completions` plus `/api/cron/media-preview-repair` keep dedicated schedules of their own (the invocation-budget arithmetic in `backend-jobs.ts` counts all three). The other `/api/cron/*` routes trigger individual registry jobs by hand; the deployment runbook records which jobs stay on the orchestrator. Read-only ops dashboards live under `/api/ops/*` behind `OPS_READ_SECRET`.

### Tests

All web unit/integration tests live flat in `src/__tests__/` (~1,190 files; `ugc-mobile/__tests__/` holds ~400 more) — never colocated. Notable conventions: `*-migration.test.ts` files assert the SQL content of migrations (add one when you add a migration); contract fixture tests pin the mobile API. E2E lives in `tests/e2e/` and uses an auth bypass (`src/lib/e2e-auth.ts`) that is build-blocked in production, and its dev server answers the server-side Supabase reads of the pages specs draw with a stub (`tests/e2e/support/supabase-server-stub.cjs`). Mobile logic is factored into `ugc-mobile/lib/*-view-model.ts` modules precisely so it can be vitest-tested without rendering.

The five E2E gotchas (a second `next dev` in the same checkout blocks Playwright's own server, the auth bypass needs its cookie, two open pages reload each other after a compile, a compile spends the timeout of whatever waits while it runs, a compile that ends mid-hydration can leave the page the server's HTML for seconds), where the dev server's env comes from, and how a page's server reads join that stub are `.claude/rules/e2e.md`, loaded with `tests/e2e/`.

## Conventions and cautions

- **Bug fixes — reproduce first, at the layer the bug actually lives**: pure logic (`src/lib/*-service.ts`, `ugc-mobile/lib/*-view-model.ts`) reproduces as a failing vitest case — write it before the fix and keep it as the regression test. Rendering, navigation, native-module, and provider-callback bugs do **not** reproduce in vitest: use `npm run test:e2e` (web) or a booted simulator/emulator (mobile has no E2E harness). Never call one of those fixed on unit-test evidence, or on a dependency bump that merely appears to help — confirm on the surface the bug was reported on. If you cannot reproduce it at all, stop and report: state what you ruled out and what evidence would confirm the cause. Never ship a speculative fix in place of a reproduction.

- **A fresh-context review before every merge** (owner's decision, 2026-10-18; cost rules 2026-11-01): run `/code-review` on the PR's diff in a fresh session at **`high` effort, not Max** — on Opus 5.x a Max-effort session loads the ten-finder, one-verifier-per-candidate, sweep agent recipe, which took 57% of a fortnight's plan usage, while `high` runs the review inside the session. Tell it to report gaps rather than style, fix or answer each finding before merging, and after the fixes run one sweep on the revised diff rather than another full review. Any finder, verifier or sweep agent a review does start is the `review-finder` agent (`.claude/agents/`: Sonnet, medium effort, read-only); the owner's user settings also force every subagent onto Sonnet (`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`), so a review cannot pass `model: opus`. The local gate (`.agents/skills/local-checks/scripts/run.sh`) runs first.
- **Subagents**: none without the owner's word in that turn, with two exceptions the owner approved on 2026-10-18: the `test-runner` agent in `.claude/agents/` (shell only, Sonnet at medium effort, reports failures only) may run test suites and the local gate, and `/code-review` may use its reviewer agents, as `review-finder`. Research or implementation fan-outs still need asking.
- **Migrations**: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`, stamped with `date -u +%Y%m%d%H%M%S`, never edited once applied, captured with `supabase db diff --local` and verified with `db reset --local`. The ledger, production-parity, grant and pgTAP rules are `.claude/rules/supabase-migrations.md`, loaded with `supabase/`; the hooks in `.claude/settings.json` refuse an edit to a migration already on `origin/main` and a stamp ahead of the UTC clock.

- **Deploys**: `.github/workflows/production-release.yml` owns production releases after the exact `main` SHA passes Quality. It applies Supabase migrations and both Edge Functions (`kie-webhook`, `embed-post`), stages a production-configured Vercel deployment without domains, verifies public and authenticated health, rejects stale SHAs, then promotes and verifies the live SHA. Vercel Git integration may create previews but must not auto-promote production. Manual `vercel --prod` is recovery-only. Pre-deploy gates and env contract: `docs/production-deployment-runbook.md`.

- **Mobile ships separately** — merging to `main` never reaches phones: store binaries go out through `mobile-store-release.yml` (never push to `main` while one is in flight), and JS-only fixes ship OTA only through `node ugc-mobile/scripts/publish-ota.mjs --platform <ios|android|all>`, reaching only binaries whose runtime fingerprint matches `ugc-mobile/ota-targets.json` exactly. The release rules (fingerprints, the publish script, Metro's shared cache, the R8 shape, EAS limits) are `.claude/rules/mobile-release.md`, loaded with `ugc-mobile/`.

- **Mobile UI and runtime rules** are `.claude/rules/mobile-ui.md` (HIG floors, native APIs before JS behaviours, the theme hook) and `.claude/rules/mobile-runtime.md` (overlay sheets, native player touches, the dev launcher, Android's fullscreen activity and Modal windows, bundle shaping, React Compiler), loaded with `ugc-mobile/`. Read both before changing anything a person sees or touches in the app.

- **Design**: start at `docs/design/design.md`, which indexes `design-web.md` (web) and `design-mobile.md` (mobile) in the same folder. North star: premium AI creator studio — shared tokens, Lucide icons, strict spacing, reusable primitives. The web is dark; mobile follows the phone's appearance (light or dark) with a Settings → Appearance override, and the reel stays dark in both. Shared web UI lives in `src/components/` (not a route). An in-repo design-engineering skill lives at `.agents/skills/emil-design-eng` (symlinked into `.claude/skills/`).
- **Path aliases differ**: web `@/*` → `src/*`; mobile `@/*` → `ugc-mobile/*` root.

- **Web styling and routing rules** (the two-sheet CSS split and its tests, rewrites defeating route interception) are `.claude/rules/web-routes-and-css.md`, loaded with `src/app/`, `src/components/` and `src/proxy.ts`.

- **Storage uploads must be Blobs**: passing a Node `Buffer` to supabase-js `storage.upload` gets it UTF-8-stringified (~1.8× larger, corrupt). Wrap bytes in a `Blob` first.
- **Metric queries**: most `profiles` rows are anonymous guest sessions — filter `is_anonymous` before any per-user metric. `profiles.credits` is the **total** spendable balance; `promotional_credits` tracks a subset of it, never add the two. Mobile IAPs double-write (see Admin console).
- **The paid-bundle paywall is app code, not RLS**: the field allowlist in `hydrateBundleRows` (`src/lib/post-resource-bundles-server.ts`) is the security boundary for unpurchased content — treat any change to bundle reads as security-sensitive.

- **Secrets**: the service-role key exists only in trusted server/operator environments — never in manifests, client bundles, command output, or committed files. Ops CLIs deliberately redact provider mappings and prices.
  - **Agents install secrets themselves, outside the conversation.** Never ask the user to paste a secret into chat or to hand-edit `.env.local`, and never print a secret value (no `echo`/`cat` of it — verify presence with `grep -c '^NAME=' .env.local` or a byte count instead). To install a value only the user holds: they copy it to the clipboard and say so, then the agent runs `printf 'NAME=%s\n' "$(pbpaste)" >> .env.local` — the value flows clipboard → file without entering the transcript. To mint a brand-new secret: generate and install in one piped command (`openssl rand -hex 32` into `.env.local` and/or `vercel env add NAME production --sensitive`), never echoed. Vercel "Sensitive" values pull back as empty strings, so retrieval from Vercel is impossible by design — and never rotate a secret that HMACs stored data (e.g. `ACCOUNT_IDENTITY_FINGERPRINT_SECRET`) just to obtain a known value: rows written under the old value become unmatchable.
- **Blog content** is markdown in `content/blog/*.md` rendered via `src/lib/blog.ts`.

## Documentation (`docs/`)

Live runbooks sit at the root of `docs/`: `production-deployment-runbook.md` (topology, env contract, gates), `local-development.md`, `supabase-local-prod-workflow.md`, `generation-model-catalog-operations.md`, `model-onboarding.md` (adding a generation model), `moderation-operations.md` (staffed queue, service-role CLI), `feed-algorithm-operations.md` (For You ranking versions: the scorecard, activating and rolling back a version, experiments, kill switches, training a draft), `mobile-store-product-catalog.md` (IAP tier provisioning), `post-resource-bundle-v1.md`, `scaling-certification-runbook.md`, `supabase-performance-inspection.md`, and `scaling-audit.md` — the active scaling entry point, which links the current finding set (`docs/audits/scaling-findings-2026-08-22.md`) and exact-build certificates (`scaling-certificates/`). Code, tests, and CI reference the runbooks by path, so they do not move. Everything dated or reference-only lives in a subfolder: `design/` (the design-system index and guides), `audits/` (dated audit reports and findings), `plans/` (open plans and scoping records — a plan moves to `archive/` with a dated status line once its work ships), `research/` (prompt-enhancer, model-prompting and media-architecture research), `model-api-references/` (captured provider API references, the input to model onboarding), `scaling-certificates/`, and `archive/` (shipped plans and dated audit journals that must not be treated as current capacity claims — `docs/scaling-audit-2026-08-08.md` survives only as a compatibility redirect stub). `docs/README.md` is the index.

## Detailed rules (`.claude/rules/`)

Path-scoped rules hold the long material that applies to one part of the tree. Claude Code loads a rule when a Read, Edit or Write touches a matching path; a session working only through shell commands must read the file itself first. The patterns start with `**/` so they match from the repo root, from a worktree and from the parent `UGC copy` folder alike.

| Rule | Loads with |
|---|---|
| `mobile-ui.md`, `mobile-runtime.md`, `mobile-release.md` | `ugc-mobile/**` (release: also the store-release workflow and `releases/`) |
| `web-mobile-contract.md` | `contracts/**`, `src/proxy.ts`, `src/app/api/**`, `src/lib/route-identity-policy.ts`, the shared catalog, policy and upload modules under `ugc-mobile/lib/`, `ugc-mobile/lib/notifications.ts` |
| `supabase-migrations.md` | `supabase/**`, `scripts/db/**`, the ledger and baseline workflows |
| `web-routes-and-css.md` | `src/app/**`, `src/components/**`, `src/**/*.css`, `src/proxy.ts`, `next.config.ts` |
| `admin-console.md` | `src/app/admin/**`, `src/app/api/admin/**`, `src/lib/admin-*` |
| `e2e.md` | `tests/e2e/**`, `playwright.config.ts`, `src/lib/e2e-auth.ts` |

`.claude/agents/` holds the two subagent definitions (`test-runner`, `review-finder`); `.agents/skills/` holds the six skills (`add-generation-model`, `emil-design-eng`, `ship-ota`, `local-checks`, `android-device`, `ios-dev-client`), each symlinked into `.claude/skills/`.

Sessions run in bypass permissions by the owner's choice (2026-10-18), so these hooks are the guard rails that hold there; edits made through shell commands sit outside `/rewind`, so prefer the Edit and Write tools for source files. `.claude/settings.json` carries the hooks that enforce what prose cannot (`.claude/hooks/`: an edit to an applied migration or a future stamp, secrets files read into the transcript, process listings, `npx expo`, `EXPO_ATLAS`, `eas update` outside the publish script, a build beside a running dev server) and keeps `.env*` and `.mcp.json` from the Read, Edit, Write and Grep tools. That block lives in the hook, not in `Read(...)`/`Edit(...)` deny rules, because a deny rule also covers every Bash command naming the path: on 2.1.309 a Read deny refused even `grep -c`, `wc -c` and `stat` on `.env.local`, and an Edit deny refuses the `>>` install and the `sed -i` toggle (moved 2026-11-01; only `.mcp.json` keeps a Read deny). Both PreToolUse hooks set `onFailure: block`, so a hook that cannot run refuses the call rather than letting it through. The `grep -c '^NAME='`, `wc -c`, `sed -i` and `printf … >> .env.local` forms work; printing, truncating (`>`) or deleting a secrets file is blocked. The parent `UGC copy/.claude/` mirrors `rules/`, `hooks/`, `agents/`, `skills/*` and `settings.json` by symlink so a session started there gets the same; anything new under `.claude/` gets its link there in the same change.

# Compact instructions

When compacting, keep: the current branch and PR number; which Supabase project `.env.local` points at; which devices and simulators are in use and any lock files held; the paths of verification evidence (recordings, screenshots, logs) and what each proved; every decision the owner made in the session, in their words where they approved something; and what is left undone.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
