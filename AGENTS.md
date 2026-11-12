# AGENTS.md

This file provides guidance to AI coding agents (Claude Code and others) when working with code in this repository. Claude Code reads it directly, so there is no `CLAUDE.md` — don't add one: a `CLAUDE.md` at or above the working directory makes Claude Code read that instead and skip this file.

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

CI (`.github/workflows/quality.yml`) gates PRs with: web `test → lint → typecheck → typecheck:scripts → typecheck:tests → perf self-tests → build → build:verify`; mobile `expo install --check → expo-doctor` (both offline, `EXPO_OFFLINE=1`; Expo's live list gates only a PR that changes the app's version, and is a report on main's runs: `ugc-mobile/__tests__/expo-install-exclude.test.ts` says why) `→ fingerprint against ota-targets.json (advisory) → expo prebuild --clean → expo export → test → typecheck`; and a full migration replay from a clean database plus `supabase test db` (Supabase CLI pinned to 2.109.1 in the workflow — the 2.75.0 pin above is for the dev Mac only). Quality also runs a Playwright E2E smoke job. Sibling workflows: `production-release.yml` (production deploys) and `mobile-store-release.yml` (store binaries + OTA) — both covered under Deploys — plus `performance.yml`, `backend-alert-watchdog.yml`, `schema-baseline.yml`, `repair-migration-ledger.yml`, and `apple-web-client-secret.yml` (renews the website's Sign in with Apple client secret monthly; the runbook's "Sign in with Apple on the web").

## Local environment

`.env.local` is hand-toggled between local and production Supabase by commenting/uncommenting the key blocks — **check which one is active before running the dev server** so you don't develop against production. Reference URLs and the toggle procedure: `docs/local-development.md`. Full variable reference: `.env.example`, which lists every `process.env` name the app reads (`e2e-smoke-readiness.test.ts` fails on one it does not, because the E2E server unsets exactly that list). `GENERATION_MODEL_CATALOG_SOURCE` is `code` for local/test, `database` in production.

## Architecture

### One backend, two clients

Vercel API routes are the business-logic boundary for both web and mobile. Supabase is the source of truth for auth, data, storage, RLS, atomic RPCs, and job locks. Clients never own pricing, provider routing, credit settlement, payment trust, or generation validation. `ugc-mobile/__tests__/backend-boundary.test.ts` enforces this on the mobile side.

### Route → adapter → service layering

`src/lib` is flat (~520 files); naming is the organization, with three layers:

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

`contracts/` holds sixteen versioned JSON contracts: five are read at runtime (the mobile CORS allowlist, universal links, resource-bundle authoring, credit packs, reserved handles) and eleven are fixtures imported by both `src/__tests__` and `ugc-mobile/__tests__`, so a breaking API change fails tests on both sides. Changing a mobile-facing route means updating the contract files and both suites. Four catalog modules under `ugc-mobile/lib/model-catalog/`, the saver notice's policy (`ugc-mobile/lib/saver-notice-policy/`), the post publish policy (`ugc-mobile/lib/post-publish-policy/`: the placeholder-title rule the server and both composers apply, the title suggested for a creation, the handle suggested to a new creator, and the creator-name step's handle rules that both `onboarding` screens follow), the video and motion creators' settings chip (`ugc-mobile/lib/creator-settings-summary/`), the creators' fitting rule (`ugc-mobile/lib/creator-run-fit/`: the settings a model opens on, the model list split by the balance; a remix keeps its original's model whatever the balance), how an unlocked recipe reads (`ugc-mobile/lib/recipe-reading/`: the order and names of its groups on the post page, the reel, the library and the app's Details), the creation settings a post shows everyone under Made with (`ugc-mobile/lib/generation-setup/`: the labels the server writes them under and the line both post pages draw, owner 2026-11-03), a creation's recipe (`ugc-mobile/lib/creation-recipe/`: the exact prompt's locked item, which saved inputs the recipe is offered and where their copies go, and the words "From this creation" says, read by the server and both composers, owner 2026-11-03), a remix's empty input slots (`ugc-mobile/lib/remix-input-slots/`: the box each input a remix is not given becomes, which boxes are open, how a fill is named, where a box has a place, and their words, owner 2026-11-03), a remix's credit (`ugc-mobile/lib/remix-credit/`: "Remix of “title” by @A · Original by @A", what it leaves out for a post no longer public or a blocked pair, and the creator's "Remixing @A’s “title”", owner 2026-11-05), the welcome-credits popup's rules (`ugc-mobile/lib/welcome-popup-policy/`: who it is offered to, the fill its figure counts up on, owner 2026-11-09), the claim's confetti flight (`ugc-mobile/lib/claim-confetti-flight/`: the seeded 48-piece burst, played by the app on the native driver and by the web with the Web Animations API), the invite a shared link carries (`ugc-mobile/lib/invite-share-link/`: the `r` parameter a signed-in account's shared post and profile links carry its invite code in, what a code looks like, how a link gains one and how a landing reads it, the rules both clients hold a sharer's code by, and the two formats an invite travels to a new install in, Play's install referrer and the link an iPhone copies, owner 2026-11-10; and the six-character invite code a person types at sign-up, `invite-typed-code.ts`: its alphabet, how typed text or a pasted link is read, and the field's words, owner 2026-11-11), a creator's payout request (`ugc-mobile/lib/creator-payout-policy/`: the methods, the details rule, the share kept and the words of both payout forms, owner 2026-11-11), the search clients' rules (`ugc-mobile/lib/public-search-policy/`: recent searches, an entity's id and count, the filters of a Posts search and the parameters they travel in, the words of the corrected reading, which the server reads a request with too; and the typeahead's rules, `search-typeahead.ts`: the answer of `/api/search/suggest`, when a box asks and draws, its sections, what a row does and the keys) and the model and settings each app creator opens on before its catalog arrives (`ugc-mobile/lib/app-creator-opening/`, held to the code catalog by `src/__tests__/app-creator-opening.test.ts`) are shared with the web by relative import and must stay free of React Native, Expo and Node imports. `src/proxy.ts` is the bearer admission boundary for every policy-listed `/api` route (`src/lib/route-identity-policy.ts`), with two guest exception lists, and `/api/showcase/feed` runs the same check at the route itself. The full contract, deep-link and admission rules are `.claude/rules/web-mobile-contract.md`, loaded when those files are touched; read it before changing any of them.

### Admin console (`/admin`)

A browser-only operator console under `src/app/admin/(console)/`, gated twice (an edge check in `src/proxy.ts`, the route check in `admin-auth.ts`) behind a single master operator credential minted with `npm run admin:credentials`. The credential format, the credit-adjustment policy and the revenue double-count rule are `.claude/rules/admin-console.md`, loaded with the admin files.

### Agent access (MCP)

`/api/mcp` is a remote MCP server (stateless Streamable HTTP, JSON answers, no sessions) that lets an agent in Claude.ai, Claude Desktop, Claude Code, ChatGPT, Codex or Cursor act as a signed-in creator: `list_models`, `get_model`, `quote_generation`, `upload_input` (a file by public https URL, fetched behind an SSRF guard, `src/lib/public-url-media-fetch.ts`, 25 MB for a picture and 50 MB for a clip or track, or by base64 up to 3 MB, or by the `upload_id` of a file the agent sent to staging itself, staged through the web's own sign → upload → finalize path, counted before any byte is fetched; the answer feeds a run or becomes a post), `request_upload` (a signed staging URL for a file on the agent's own machine, at the URL caps, with the curl line that PUTs it; `upload_input` then holds its first bytes to the signature rule and finalizes it; an account has four uploads open at most, a refused one keeping its place until the daily reclaim, so an agent sends one file at a time, `src/lib/agent-input-upload.ts`), `create_media` (quote-then-create: `expected_cost_credits` is required and the start never charges above it, answering `COST_CHANGED` instead), `get_generation` (a finished picture's preview inline under 512 KB, on `include_preview`), `list_creations`, `publish_post` (live by default, `visibility: private` to keep it on the profile; the web's publish limit plus `AGENT_PUBLISH_RATE_LIMIT`, 10 public agent posts per account per UTC day, counted from the audit table so a refused publish spends nothing; a republish returns the existing post; a creation an operator removed is never republished, by the publish service itself; since phase 4 it takes one source of three: `generation_id`; `uploads`, 1 to 5 files staged through `upload_input`, media made elsewhere, with a required title and `made_with` (free text, never Magicbooklet's own name, never a new catalog row); or neither, a text post of a title and a body. The last two are published by the composer's own create under a post id derived from the creator and the staged paths, or the title and text, so a repeat answers the same post, and may carry `resources`: cards of text and links (`prompt`, `guide`, `external_link`) serialized by the composer's own `buildResourceCardBundleInput`, which is how an agent shares a prompt, a guide or a skill. `resource_price_tokens` prices a resource, the cards or a creation's recipe: a whole number of tokens, 10 or more in steps of 10, refused or passed as given and never computed, with the services' validators the authority and the agent told to state the price and get the person's yes, `src/lib/agent-upload-publish-request.ts` and `agent-publish-request.ts`), `get_post` (which says of a post's resource its access, price and status, read as four columns in `agent-post-read.ts`: no agent tool reads what a resource holds, and `hydrateBundleRows` is not called), `delete_post` and `enhance_prompt`, each a thin layer over the services the web calls (`src/lib/mcp-server-service.ts`; HTTP in `src/lib/mcp-route-adapter-service.ts`). Every call writes one row of `public.agent_tool_calls` behind its answer (`src/lib/agent-tool-calls.ts`: tool, outcome, code, creation, post, cost; owner-read RLS, service-role append only), which `npm run ops:moderation -- list --source agent` reads to list agent-published posts, and a creator disconnects an agent under Connected apps on `/profile/edit` (`src/lib/connected-apps.ts`, Supabase Auth's grants API). Authorization is OAuth 2.1 through Supabase Auth's OAuth server, so an agent token is an ordinary Supabase JWT carrying a `client_id` claim: `src/lib/agent-token.ts` is the one place that says what makes a token an agent's, the MCP route requires that claim (403 `AGENT_TOKEN_REQUIRED`), every other `/api` route refuses it (403 `AGENT_TOKEN_NOT_ALLOWED`, in the shared evaluator) and `getServerAuthState` refuses it as a web session. That keeps the token off this app's other surfaces only: against the Supabase project directly it is the creator's session under RLS like any user token, and a leak is answered by revoking the grant (which deletes the token's session) or by the one-hour expiry. The route owns its admission (`src/lib/route-owned-identity-admission.ts`, with the feed's reads) so a missing or invalid token gets the `WWW-Authenticate` challenge pointing at `/.well-known/oauth-protected-resource/api/mcp` (`src/lib/oauth-protected-resource-metadata.ts`), and a revoked grant signs the agent out through the lifecycle round trip (`session_valid: false`), never a signature-only check. The consent screen is `/oauth/consent` (`src/lib/oauth-consent-service.ts`: sign-in redirect, the guest wall GoTrue itself would not show, the already-approved redirect, the fixed access list, approve and deny). OAuth clients are registered with `npm run ops:oauth-clients`. `MCP_SERVER_DISABLED=1` is the kill switch, for both paths: `/api/mcp/posts` is the same server posting-only (`src/lib/mcp-surfaces.ts`: `upload_input`, `request_upload`, `list_creations`, `publish_post`, `get_post`, `delete_post`, and no tool, description or answer that starts a run or spends a credit), the one submitted to Claude's connectors directory, which lists no connector that generates media. It is a protected resource of its own (its 401 names `/.well-known/oauth-protected-resource/api/mcp/posts`), documented at `/developers/mcp/posting`, and its OAuth clients are posting-only (`MCP_POSTING_ONLY_CLIENT_IDS` in `src/lib/mcp-client-directory.ts`, a deny-list an id leaves only once its client is deleted): the consent page and Connected apps show such a client a posting-only list and its token answers 403 `AGENT_SURFACE_NOT_ALLOWED` at `/api/mcp`. Plan, spike and runbook: `docs/plans/agent-mcp-server-plan-2026-11-09.md`, `docs/research/mcp-oauth-spike-2026-11-09.md`, `docs/mcp-server-operations.md`.

Distribution (runbook, "Distribution"): `/developers/mcp` is the public setup page, its client ids, ports and commands from `src/lib/mcp-client-directory.ts` (a `CLIENT_ID_PENDING_<SURFACE>` id shows that client as coming soon), and `server.json` at the root is the MCP registry entry, `com.magicbooklet/mcp`, proven by `/.well-known/mcp-registry-auth`. Two top-level folders serve Claude Code users, not this repository's agents:

- `.claude-plugin/` — the plugin marketplace this public repository serves (`claude plugin marketplace add 112kratoss/ugc-copy`).
- `plugins/` — its plugins: `plugins/magicbooklet/`, the MCP server and four skills, held to the client directory by `mcp-distribution-manifests.test.ts`.

### Background jobs

Three Vercel crons run every 10 min under `CRON_SECRET` bearer auth: `/api/cron/backend-jobs` dispatches the job registry in `src/lib/backend-jobs.ts` (completion polling, media preview repair, feed maintenance, push receipts, referral rewards, alert delivery) under DB job locks with a daily invocation budget, and `/api/cron/generation-completions` plus `/api/cron/media-preview-repair` keep dedicated schedules of their own (the invocation-budget arithmetic in `backend-jobs.ts` counts all three). The other `/api/cron/*` routes trigger individual registry jobs by hand; the deployment runbook records which jobs stay on the orchestrator. Read-only ops dashboards live under `/api/ops/*` behind `OPS_READ_SECRET`.

### Tests

All web unit/integration tests live flat in `src/__tests__/` (~1,050 files; `ugc-mobile/__tests__/` holds ~360 more) — never colocated. Notable conventions: `*-migration.test.ts` files assert the SQL content of migrations (add one when you add a migration); contract fixture tests pin the mobile API. E2E lives in `tests/e2e/` and uses an auth bypass (`src/lib/e2e-auth.ts`) that is build-blocked in production, and its dev server answers the server-side Supabase reads of the pages specs draw with a stub (`tests/e2e/support/supabase-server-stub.cjs`). Mobile logic is factored into `ugc-mobile/lib/*-view-model.ts` modules precisely so it can be vitest-tested without rendering.

The five E2E gotchas (a second `next dev` in the same checkout blocks Playwright's own server, the auth bypass needs its cookie, two open pages reload each other after a compile, a compile spends the timeout of whatever waits while it runs, a compile that ends mid-hydration can leave the page the server's HTML for seconds), where the dev server's env comes from, and how a page's server reads join that stub are `.claude/rules/e2e.md`, loaded with `tests/e2e/`.

## Conventions and cautions

- **Bug fixes — reproduce first, at the layer the bug actually lives**: pure logic (`src/lib/*-service.ts`, `ugc-mobile/lib/*-view-model.ts`) reproduces as a failing vitest case — write it before the fix and keep it as the regression test. Rendering, navigation, native-module, and provider-callback bugs do **not** reproduce in vitest: use `npm run test:e2e` (web) or a booted simulator/emulator (mobile has no E2E harness). Never call one of those fixed on unit-test evidence, or on a dependency bump that merely appears to help — confirm on the surface the bug was reported on. If you cannot reproduce it at all, stop and report: state what you ruled out and what evidence would confirm the cause. Never ship a speculative fix in place of a reproduction.

- **A fresh-context review before every merge, sized to the change** (owner's decisions, 2026-10-18 and 2026-11-03): after the local gate (`.agents/skills/local-checks/scripts/run.sh`), a session that did not write the code reviews the PR's diff, told to report gaps rather than style, and each finding is fixed or answered before merging. Start it with `start_session` (fresh context, in the branch's checkout, no `model`: on Sonnet even `high` starts agents), telling it to run `/code-review <level> <PR#>`, the level first (typed after the target it is read as part of the target; left out, the last level typed or the session's effort is used). The level is `max` for a risky diff — one that touches credits, payments or model prices (catalog releases included), sign-in or route admission, migrations, secrets or the agent guard (`.claude/settings.json`, `.claude/hooks/`), the paid-bundle paywall or webhooks, or changes more than 300 lines (added plus deleted, lockfiles aside) — which runs ten finder agents, a verify and a sweep; any other diff gets `high`, one careful pass by that session alone. Its note back quotes only the start of its report, so read the findings with `list_events`. A `CLAUDE_CODE_EFFORT_LEVEL` in the environment outranks the typed level and every effort the app sets, so it stays unset wherever Claude Code runs: exported as `max` from the dev Mac's `~/.zshrc`, it made every review through 2026-11-03 the `max` one.
- **Reviewer models** (owner's decision, 2026-11-01): `/code-review` leaves each reviewer agent's model to the session. A reviewer started without one runs on its agent type's model, or on the session's when the type sets none (`feature-dev:code-reviewer` sets Sonnet), and a fork ignores `model` altogether, so start every reviewer as a typed agent, never a fork, and name `model` on it, chosen from the PR. A finder that carries any correctness angle, the sweep, and any verifier agent get `opus` when the diff is risky (the list in the bullet above), and `sonnet` otherwise. A finder that carries only reuse, simplification, efficiency, altitude or conventions gets `sonnet`. Verify the candidates in the review session in place of the recipe's verifier agents, keeping its vote: a candidate stays unless it is refuted.
- **Subagents**: none without the owner's word in that turn, with two exceptions the owner approved on 2026-10-18: the `test-runner` agent in `.claude/agents/` (shell only, a cheaper model, reports failures only) may run test suites and the local gate, and `/code-review` may use its reviewer agents. Research or implementation fan-outs still need asking.
- **Migrations**: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`, stamped with `date -u +%Y%m%d%H%M%S`, never edited once applied, captured with `supabase db diff --local` and verified with `db reset --local`. The ledger, production-parity, grant and pgTAP rules are `.claude/rules/supabase-migrations.md`, loaded with `supabase/`; the hooks in `.claude/settings.json` refuse an edit to a migration already on `origin/main` and a stamp ahead of the UTC clock.

- **Deploys**: `.github/workflows/production-release.yml` owns production releases after the exact `main` SHA passes Quality. It applies Supabase migrations and both Edge Functions (`kie-webhook`, `embed-post`), stages a production-configured Vercel deployment without domains, verifies public and authenticated health, rejects stale SHAs, then promotes and verifies the live SHA. Vercel Git integration may create previews but must not auto-promote production. Manual `vercel --prod` is recovery-only. Pre-deploy gates and env contract: `docs/production-deployment-runbook.md`.

- **Mobile ships separately** — merging to `main` never reaches phones: store binaries go out through `mobile-store-release.yml` (never push to `main` while one is in flight), and JS-only fixes ship OTA only through `node ugc-mobile/scripts/publish-ota.mjs --platform <ios|android|all>` (its `--publish` only on the owner's word in this session's chat for that update; the `ship-ota` skill says what counts), reaching only binaries whose runtime fingerprint matches `ugc-mobile/ota-targets.json` exactly. The release rules (fingerprints, the publish script, Metro's shared cache, the R8 shape, EAS limits) are `.claude/rules/mobile-release.md`, loaded with `ugc-mobile/`.

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

Live runbooks sit at the root of `docs/`: `production-deployment-runbook.md` (topology, env contract, gates), `local-development.md`, `supabase-local-prod-workflow.md`, `generation-model-catalog-operations.md`, `model-onboarding.md` (adding a generation model), `moderation-operations.md` (staffed queue, service-role CLI), `mcp-server-operations.md` (the agents' MCP server: OAuth clients, kill switch, logs), `mobile-store-product-catalog.md` (IAP tier provisioning), `post-resource-bundle-v1.md`, `scaling-certification-runbook.md`, `supabase-performance-inspection.md`, and `scaling-audit.md` — the active scaling entry point, which links the current finding set (`docs/audits/scaling-findings-2026-08-22.md`) and exact-build certificates (`scaling-certificates/`). Code, tests, and CI reference the runbooks by path, so they do not move. Everything dated or reference-only lives in a subfolder: `design/` (the design-system index and guides), `audits/` (dated audit reports and findings), `plans/` (open plans and scoping records — a plan moves to `archive/` with a dated status line once its work ships), `research/` (prompt-enhancer, model-prompting and media-architecture research), `model-api-references/` (captured provider API references, the input to model onboarding), `scaling-certificates/`, and `archive/` (shipped plans and dated audit journals that must not be treated as current capacity claims — `docs/scaling-audit-2026-08-08.md` survives only as a compatibility redirect stub). `docs/README.md` is the index.

## Detailed rules (`.claude/rules/`)

Path-scoped rules hold the long material that applies to one part of the tree. Claude Code loads a rule when a Read, Edit or Write touches a matching path; a session working only through shell commands must read the file itself first. The patterns start with `**/` so they match from the repo root, from a worktree and from the parent `UGC copy` folder alike.

| Rule | Loads with |
|---|---|
| `mobile-ui.md`, `mobile-runtime.md`, `mobile-release.md` | `ugc-mobile/**` (release: also the store-release workflow and `releases/`) |
| `web-mobile-contract.md` | `contracts/**`, `src/proxy.ts`, `src/app/api/**`, `src/lib/route-identity-policy.ts`, the shared catalog modules, `ugc-mobile/lib/notifications.ts` |
| `supabase-migrations.md` | `supabase/**`, `scripts/db/**`, the ledger and baseline workflows |
| `web-routes-and-css.md` | `src/app/**`, `src/components/**`, `src/**/*.css`, `src/proxy.ts`, `next.config.ts` |
| `admin-console.md` | `src/app/admin/**`, `src/app/api/admin/**`, `src/lib/admin-*` |
| `e2e.md` | `tests/e2e/**`, `playwright.config.ts`, `src/lib/e2e-auth.ts` |

`.claude/agents/test-runner.md` is the one subagent definition; `.agents/skills/` holds the six skills (`add-generation-model`, `emil-design-eng`, `ship-ota`, `local-checks`, `android-device`, `ios-dev-client`), each symlinked into `.claude/skills/`.

Sessions run in bypass permissions by the owner's choice (2026-10-18), so these hooks are the guard rails that hold there; edits made through shell commands sit outside `/rewind`, so prefer the Edit and Write tools for source files. `.claude/settings.json` carries the hooks that enforce what prose cannot (`.claude/hooks/`: an edit to an applied migration or a future stamp, process listings, `npx expo`, `EXPO_ATLAS`, `eas update` outside the publish script, a build beside a running dev server) and the guard on secrets files (`.env*` but not `.env.example`, and `.mcp.json`): `protect-migrations.py` refuses them to the Read, Edit, Write and Grep tools, by name, through a symlink or by a Grep glob that picks one out; `guard-prompt.py` refuses a prompt that `@`-mentions one, since Claude Code pastes a mentioned file in without a tool call; and `guard-bash.py`, for Bash and Monitor commands, refuses printing one (a search may print only the `NEXT_PUBLIC_SUPABASE_URL` line), reading it through `<`, truncating it, or deleting, moving or copying over it, and appending through `>>` stays open. The guard lives in hooks, not in `Read(...)`/`Edit(...)` deny rules, because a deny rule also covers the Bash commands that name the path: on 2.1.309 a Read deny refused even `grep -c`, `wc -c` and `stat` on `.env.local`, and an Edit deny refuses the `>>` install and the `sed -i` toggle (moved 2026-11-01; only `.mcp.json` keeps a Read deny). The file-tools hook fails closed (`onFailure: block`): if python3 cannot run, those tools are refused and Bash stays open for the repair. The Bash hook fails open when python3 cannot start, with a hook-error notice on every call, but refuses a secrets-file command when its own check errors. The `grep -c '^NAME='`, `wc -c`, `sed -i` and `printf … >> .env.local` forms work. Not covered: a connected IDE's open-file context, which the Read deny covered best-effort, and a script that opens the file itself (`python3 -c …`), which no rule covered. The parent `UGC copy/.claude/` mirrors `rules/`, `hooks/`, `agents/`, `skills/*` and `settings.json` by symlink so a session started there gets the same; anything new under `.claude/` gets its link there in the same change.

# Compact instructions

When compacting, keep: the current branch and PR number; which Supabase project `.env.local` points at; which devices and simulators are in use and any lock files held; the paths of verification evidence (recordings, screenshots, logs) and what each proved; every decision the owner made in the session, in their words where they approved something; and what is left undone.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
