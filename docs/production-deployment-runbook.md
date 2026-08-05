# Production Deployment And Operations Runbook

Last updated: 2026-08-04

## Production Topology

- Web and shared API: Vercel Pro project `ugc-app`.
- Function region: `bom1` (Mumbai), version-controlled in `vercel.json`.
- Database, Auth, and Storage: Supabase Pro project `ildfmhozpibwiopeavfg` in `ap-south-1` (Mumbai).
- Production branch: `main`.
- Production domains: `magicbooklet.com` and `www.magicbooklet.com`.
- Background scheduler: `/api/cron/backend-jobs` every ten minutes.

`.github/workflows/production-release.yml` owns normal production releases. It runs
only after every `Quality` job succeeds for the current `main` SHA, applies
Supabase migrations, deploys the Edge Function, creates a production-configured
Vercel deployment without assigning the domains, verifies that deployment, and
only then promotes it. Vercel Git integration may continue to create previews,
but it must not independently move the production domains for `main`.

The same workflow has a guarded manual entry point for configuration-only
redeployments. It ignores the branch selected in the GitHub Actions UI, resolves
the current remote `main` SHA, and requires a successful push-triggered `Quality`
run for that exact SHA before it can enter the protected `production`
environment. The operator must declare whether abandoned-upload reclaim is
expected to be effectively enabled; the staged protected health response must
match that declaration before promotion.

## Required Environment Contract

The protected backend health endpoint reports only missing capability names, never values. Production requires:

- Supabase URL: `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`.
- Supabase client key: `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Supabase privileged key: `SUPABASE_SERVICE_ROLE_KEY`.
- Canonical origin: `NEXT_PUBLIC_SITE_URL`.
- Scheduler authentication: `CRON_SECRET`. `CRON_SECRET_PREVIOUS` is a temporary rotation-only variable (see the rotation procedure below).
- Protected ops dashboard authentication: `OPS_READ_SECRET`. `OPS_READ_SECRET_PREVIOUS` is a temporary rotation-only variable (see the rotation procedure below).
- Generation provider: `KIE_AI_API_KEY`.
- Generation model catalog: `GENERATION_MODEL_CATALOG_SOURCE` set to `shadow` while comparing a candidate database release, then `database` after the active release is verified. `code` is the emergency fallback.
- Generation webhook ingress: `KIE_PROVIDER_WEBHOOK_SECRET` (with legacy `WEBHOOK_SECRET` accepted only during rotation). KIE callbacks go to the Supabase `kie-webhook` Edge Function, never directly to the HMAC-only application endpoint.
- Generation webhook forwarding authentication: `KIE_WEBHOOK_HMAC_KEY`; the Edge Function signs the provider task id and a five-minute timestamp before forwarding to Vercel. `KIE_PROVIDER_WEBHOOK_SECRET_PREVIOUS`, `KIE_WEBHOOK_HMAC_KEY_PREVIOUS`, and `WEBHOOK_SECRET_PREVIOUS` are temporary rotation-only variables and should be removed after in-flight jobs expire.

Kie only supports a callback URL for this integration, so the provider ingress
credential remains in that URL's query string. Treat the entire callback URL as
a secret: it must not be copied into application logs, tickets, analytics, or
error payloads. The Edge Function accepts the current and previous provider
secret for rotation, compares fixed-length digests, bounds the request body,
and applies a 15-second timeout to the signed Vercel forward.
- Provider media import allowlist: `MEDIA_IMPORT_HOST_ALLOWLIST` (comma-separated HTTPS hostnames; `*.example.com` matches subdomains only). Include every provider CDN host that can appear in temporary generation output URLs. Imports fail closed when a host is absent, redirects leave the allowlist, DNS resolves privately, the media type is invalid, or the response exceeds its byte limit.
- Razorpay: `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.
- RevenueCat: `REVENUECAT_SECRET_API_KEY` or `REVENUECAT_REST_API_KEY`, plus `REVENUECAT_WEBHOOK_AUTH_TOKEN`.
- Invite attribution hashing: `REFERRAL_ATTRIBUTION_HASH_SECRET` set to a dedicated long random secret.
- Verified iOS links: `APPLE_TEAM_ID` and `IOS_BUNDLE_ID`.
- Verified Android links: `ANDROID_APP_SHA256_FINGERPRINTS` and `ANDROID_PACKAGE_NAME`.
- Release identity: `RELEASE_GIT_SHA` is injected by the production release
  workflow. Do not configure it manually in Vercel.

`NEXT_PUBLIC_APP_STORE_URL` and `NEXT_PUBLIC_PLAY_STORE_URL` are optional until their store listings are live. When present, they are the install fallbacks on public invite links.

Optional alert delivery can be enabled with `BACKEND_ALERT_DELIVERY_URL`, plus optional `BACKEND_ALERT_DELIVERY_AUTH_HEADER`. The protected backend dashboard is the no-extra-vendor monitoring baseline, so the external alert hook is not a required production capability.

`MEDIA_UPLOAD_RECLAIM_ABANDONED` is an optional, deliberately-off gate on the
`media-upload-reclaim` job — see "Staged Upload Reclaim" below before setting it.

Vercel environment values are captured when a deployment is built. Adding,
changing, or removing a Production environment value does not alter the running
deployment: complete a verified configuration-only redeployment after every
such change. This includes both setting and removing
`MEDIA_UPLOAD_RECLAIM_ABANDONED`.

Keep secrets scoped to Production unless a separate preview environment has isolated provider credentials and an isolated database. Never connect untrusted preview branches to production service-role credentials.

### Rotating `CRON_SECRET` And `OPS_READ_SECRET`

Both secrets support dual-key rotation, mirroring the KIE `*_PREVIOUS` webhook pattern, so rotation is a two-step deploy instead of a hard cutover:

1. Copy the current value into `CRON_SECRET_PREVIOUS` (or `OPS_READ_SECRET_PREVIOUS`) in the Vercel Production environment.
2. Set a new value in `CRON_SECRET` (or `OPS_READ_SECRET`) and redeploy. Both values now authenticate, so Vercel cron and any external monitor keep working mid-rotation.
3. Move every external consumer to the new value. Vercel cron reads `CRON_SECRET` from the same environment and follows automatically; uptime monitors and operator scripts that call `/api/ops/*` must be updated by hand.
4. Remove the `*_PREVIOUS` variable and redeploy. Confirm the old value now receives `401` and the new value still receives `200`.

Authorization stays fail-closed: when neither the primary nor the `*_PREVIOUS` variable is configured, every request is rejected. Do not leave `*_PREVIOUS` values in place after rotation completes.

## Pre-Deployment Gate

1. Confirm the intended branch and worktree scope with `git status --short --branch`.
2. Review migration parity with `supabase migration list --linked`.
3. Preview database changes with `supabase db push --linked --dry-run`.
4. Run the focused tests for changed domains.
5. Run the broad gates:

```bash
npm ci
npm test
npm run lint
npm run build
npm audit --omit=dev
cd ugc-mobile
npm ci
npm test
npm run typecheck
```

6. List production environment variable names without pulling values:

```bash
npx --yes vercel@57.0.0 env ls production --format=json
```

7. Confirm Supabase security and performance advisors. Leaked-password protection must be enabled before broad public launch. Use percentage-based Auth database connections before increasing compute size.

## External Dashboard Gates

These settings are intentionally verified against the provider dashboards/advisors because they are outside the application codebase:

- GitHub `production` environment: configure `SUPABASE_ACCESS_TOKEN`,
  `SUPABASE_PROJECT_REF`, `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID`, `VERCEL_TOKEN`, and `OPS_READ_SECRET`; set
  `PRODUCTION_BASE_URL` as an environment variable. Protect the environment
  with the repository's chosen release approvers.
- Vercel project: keep Git previews if useful, but disable independent automatic
  production-domain assignment for `main`. Configure the `Quality` GitHub
  Actions workflow as a required Deployment Check as a second guard. Verify
  with a harmless release that a failed or still-running `Quality` workflow
  cannot move `magicbooklet.com`; only `Production release` may promote it.
- Supabase project `ildfmhozpibwiopeavfg`: enable leaked-password protection in Auth Email/password settings, then re-run security advisors until `auth_leaked_password_protection` is gone. Supabase docs: `https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection`.
- Supabase project `ildfmhozpibwiopeavfg`: switch Auth database connections from the fixed `10` connection strategy to percentage-based allocation before increasing compute size, then re-run performance advisors until `auth_db_connections_absolute` is gone. Supabase docs: `https://supabase.com/docs/guides/deployment/going-into-prod`.
- Google Auth Platform: set Branding app name to `Magicbooklet`, add `magicbooklet.com` as an authorized domain, publish/verify the OAuth consent screen, and keep the production Google OAuth client connected in Supabase Dashboard > Auth > Providers > Google. Supabase docs: `https://supabase.com/docs/guides/auth/social-login/auth-google`.
- Supabase project `ildfmhozpibwiopeavfg`: add a branded custom domain such as `auth.magicbooklet.com` or `api.magicbooklet.com` before broad social-login launch. In the Google OAuth client, allow both `https://ildfmhozpibwiopeavfg.supabase.co/auth/v1/callback` and the branded `https://<supabase-custom-domain>/auth/v1/callback` until cutover is verified. Supabase docs: `https://supabase.com/docs/guides/platform/custom-domains`.
- RevenueCat project `proj4a602455`: send a production test webhook for integration `whintgr1689ecfb68` to `https://magicbooklet.com/api/mobile/commerce/revenuecat-webhook`, then verify Vercel logs show the route accepted the signed event. Current configured event types are `cancellation`, `non_renewing_purchase`, and `refund_reversed`.

The local Supabase config baseline is intentionally stricter than the original project default: `minimum_password_length = 8`, `password_requirements = "lower_upper_letters_digits_symbols"`, and `secure_password_change = true`. Do not push a Supabase config change that weakens those values.

The web login code already redirects Google sign-in back to `https://magicbooklet.com/auth/callback`. If Google's account chooser still says it will continue to `ildfmhozpibwiopeavfg.supabase.co`, the fix is not a Next.js button change: complete Google Auth Platform branding and activate a Supabase custom domain. Once the custom domain is active, update production `NEXT_PUBLIC_SUPABASE_URL` to that branded Supabase URL and redeploy so new OAuth flows advertise the branded callback host.

Use the repeatable production gate helper after each external change:

```bash
npm run ops:external-gates
```

For Supabase Auth, prefer the narrow Management API patch over `supabase config push`. The local `supabase/config.toml` also contains development rate-limit and email-confirmation settings, so a broad config push can unintentionally mutate production. With a scoped Supabase Management API token, this command applies only leaked-password protection and the Auth DB connection strategy:

```bash
SUPABASE_MANAGEMENT_API_TOKEN=... npm run ops:external-gates -- --apply-supabase-auth
```

The default patch is `password_hibp_enabled = true`, `db_max_pool_size_unit = "percent"`, and `db_max_pool_size = 17`. The `17%` value preserves the current effective Auth cap of roughly 10 connections on the current 60-connection database while allowing the cap to scale with future compute upgrades. Override it with `SUPABASE_AUTH_DB_POOL_PERCENT` only after reviewing live connection telemetry or Supabase support guidance.

For RevenueCat, first verify that the deployed endpoint accepts the same configured authorization header without mutating purchase state. This sends a harmless `TEST` event that the backend intentionally ignores with `200` and private no-store headers:

```bash
REVENUECAT_WEBHOOK_AUTH_TOKEN='Bearer ...' npm run ops:external-gates -- --probe-revenuecat-webhook
```

This probe does not replace the provider-dashboard gate. After it passes, send the RevenueCat dashboard test webhook for integration `whintgr1689ecfb68` and verify Vercel logs show a provider-delivered `POST /api/mobile/commerce/revenuecat-webhook` returning `200`.

## Deployment Order

1. Keep schema changes additive and compatible with the currently released web and mobile clients.
2. Commit and push the reviewed code to `main` once.
3. `Quality` replays all migrations, runs database behavior tests, and verifies the web, E2E, and mobile gates.
4. A successful `Quality` run triggers `Production release` for its exact SHA.
5. The release workflow refuses stale SHAs, previews and applies Supabase migrations, and deploys `kie-webhook`.
6. It creates a production-configured Vercel deployment with `--skip-domain`, verifies public and protected health plus `/api/app-version`, and checks `buildId` equals the quality-verified SHA.
7. It re-checks that `main` has not advanced, promotes the staged deployment, and verifies the production domain serves the same SHA.
8. Monitor runtime errors, backend alerts, provider failures, and payment reconciliation for at least one scheduler interval.

If the release workflow fails before promotion, production domains remain on the
last known-good deployment. Do not manually promote the staged deployment until
the failed gate is understood. Ad-hoc production deployment is recovery-only and
must be recorded in the change history.

### Configuration-only redeployment

Use the manual `Production release` workflow after changing a Vercel Production
environment value. Do not run `vercel --prod` locally and do not promote a
deployment from the Vercel dashboard.

1. Confirm the intended environment change is saved in Vercel Production.
2. Confirm current `main` has a successful push-triggered `Quality` run.
3. In GitHub Actions, run `Production release`. Set
   `expected_abandoned_reclaim_effective` to the state that should be reported
   after all gates are applied: `true` only when the environment flag is set and
   the code-controlled minimum app version permits abandoned reclaim; otherwise
   `false`.
4. The workflow resolves current remote `main`, stages a new deployment using
   Production values, authenticates to `/api/ops/backend-health`, and refuses to
   promote unless `reclaimPolicy.abandonedReclaimEffective` matches the declared
   state.
5. After promotion, confirm the production domain serves the workflow's exact
   SHA and perform the applicable smoke tests.

Selecting another branch in the Actions UI cannot deploy it: the workflow always
resolves and checks out current remote `main`. A changed or missing effective
reclaim state leaves the deployment staged and production untouched.

## Generation Model Catalog Control Plane

The active Supabase release is the authoritative source for web and mobile model names, controls, lifecycle, provider IDs, and pricing when `GENERATION_MODEL_CATALOG_SOURCE=database`. Clients receive only the sanitized public descriptor through `/api/generation-models`; they never read the catalog tables or private provider configuration directly.

Manage releases through Supabase Studio SQL or another service-role session. There is intentionally no public admin UI in v1:

1. Clone the active revision with `clone_generation_model_catalog(active_revision, new_revision, change_note, operator)`.
2. Edit only the new draft release and its entries. Keep model identity and kind unchanged.
3. Review web/mobile defaults, public descriptors, adapter allowlists, provider IDs, pricing, and verification configuration.
4. Set the release to `shadow`, run application checks with `GENERATION_MODEL_CATALOG_SOURCE=shadow`, and review `generation_model_catalog_shadow_mismatch` logs.
5. Publish atomically with `publish_generation_model_catalog(release_id, expected_active_revision)` and switch the application to `database` after verification.
6. Roll back without destructive edits using `rollback_generation_model_catalog(target_revision, expected_active_revision)`.

Provider verification runs daily as `generation-model-verification`, records sanitized results in `generation_model_provider_checks`, and never publishes or retires a model automatically. Two consecutive discrepancies mark the check degraded for operator review.

## Post-Deployment Smoke Tests

Store `OPS_READ_SECRET` and `CRON_SECRET` in temporary shell environments without printing them. Use `OPS_READ_SECRET` for read-only ops dashboard smoke tests and `CRON_SECRET` only for scheduler/cron tests. Do not place either value in documentation or command history.

### Build And Region

- Confirm the deployment commit SHA matches the intended release.
- Confirm Vercel reports Node.js 24.x and Fluid Compute enabled.
- Confirm `x-vercel-id` routes function execution through `bom1`, matching the Supabase Mumbai region.
- Confirm project cron definitions contain only `/api/cron/backend-jobs` with `*/10 * * * *`.

### Public Cache Contract

```bash
curl -sS -D - -o /dev/null \
  'https://magicbooklet.com/api/generation-models?platform=web&schemaVersion=1'
```

Expect `200`, an `ETag`, and public five-minute caching with stale revalidation.

### Private Cache Contract

```bash
curl -sS -D - -o /dev/null \
  https://magicbooklet.com/api/ops/backend-health
```

Expect `401`, `Cache-Control: private, no-store`, and no shared-cache hit. Repeat for a private mobile endpoint such as `/api/mobile/notifications`.

### Scheduler And Health

```bash
curl -sS \
  -H "Authorization: Bearer $OPS_READ_SECRET" \
  https://magicbooklet.com/api/ops/backend-health

curl -sS \
  -H "Authorization: Bearer $OPS_READ_SECRET" \
  https://magicbooklet.com/api/ops/backend-dashboard

curl -sS \
  -H "Authorization: Bearer $OPS_READ_SECRET" \
  https://magicbooklet.com/api/ops/backend-alerts
```

Expect a configured environment, a current build id, no stale scheduler, no settlement backlog, and no missing required capability. A degraded response blocks release promotion until understood.

## Identity Policy: OAuth Only

Decided 2026-07-25. Magicbooklet authenticates through Google and Apple only. No
SMTP sender is provisioned, and none is planned.

This is a deliberate choice rather than an outstanding task. Without an SMTP
sender, Supabase Auth cannot send password-reset, address-confirmation, or
email-change mail. An email/password account created in that state has no
recovery path: a forgotten password becomes a permanently inaccessible account.
Offering it would be worse than not offering it, so `hook_block_password_signups_until_smtp`
rejects `provider = 'email'` sign-ups with a 403 and the message
"Email sign-up is temporarily unavailable. Continue with Google or Apple."

Keep `auth.email.enable_confirmations = false` while this policy holds; enabling
confirmations without a sender would silently block every affected sign-in.

### Legacy email/password accounts

Accounts created with the `email` provider *before* the hook was installed still
exist and are still able to sign in. As of 2026-07-25 there were six, of which
two had never confirmed their address. **These accounts have no self-service
password reset.**

If one of them is locked out, recovery is a manual, staff-run process:

1. Confirm the request is genuine out of band. There is no confirmed email
   address to verify against for the unconfirmed accounts, so identity has to be
   established some other way — a prior support thread, a purchase record, or
   ownership of published content.
2. Prefer migrating the account to Google or Apple over restoring password
   access, so it stops depending on this manual path.
3. Record the action and its rationale, as with any privileged account change.

Do not restore self-service reset by enabling SMTP piecemeal for these accounts.
Either the OAuth-only policy holds, or SMTP is provisioned properly and this
whole section is retired along with the hook.

### Reversing this decision

If email/password sign-up is ever wanted:

1. Provision an SMTP sender in Supabase Dashboard → Auth → SMTP Settings.
2. Set `auth.email.enable_confirmations = true` in `supabase/config.toml`.
3. Drop or disable `hook_block_password_signups_until_smtp`.
4. Re-run the Supabase Auth advisors and confirm no warnings remain.
5. Give the legacy accounts above a reset path before announcing the change.

## Staged Upload Reclaim

`uploads` is the shared staging bucket: the post composer and the generation
input pipeline both sign objects into it and copy the bytes elsewhere once the
work is claimed. `media_upload_intents` records every signed upload, and the
daily `media-upload-reclaim` job deletes staged objects nothing needs any more —
48 hours after they were signed.

The job also repairs before it reclaims, because some staged objects are not
redundant at all — see "Legacy generation references" below.

The reclaim half runs in two parts, and only one of them is on by default.

**Consumed intents (on by default).** A generation input is copied into
`generation_inputs` and the staging object is deliberately left in place, because
an unchanged picker selection can be submitted twice and the second run re-sends
the same path. These were previously never deleted at all, so every generation
with an uploaded input left a permanent duplicate. Nothing client-side depends on
them, so the sweep collects them from day one.

**Never-consumed intents (`MEDIA_UPLOAD_RECLAIM_ABANDONED=true`).** These are
abandoned composer drafts. **Do not enable this until the mobile build that
verifies draft media on resume has reached the installed base.** Mobile persists
composer drafts — storage paths included — and builds without that fix restore a
draft without checking whether its staged objects still exist. Reclaiming one
makes the draft fail at publish with `Failed to load uploaded media` and no
recovery path, while the composer still looks completely intact.

Raising the reclaim TTL is *not* a substitute for waiting. Those builds refresh a
draft's expiry every time the composer is opened, so a draft can outlive its
media by an unbounded margin. The fix is client-side or nothing.

### Legacy generation references

`persistGenerationInputMedia` catches per-candidate failures and only logs them,
so a transient error leaves a generation with **zero** `generation_input_media`
rows while its `workflow_settings` still name the staged paths. Three read paths
then fall back to `buildLegacyGenerationInputMedia` and serve those staging
objects directly: the owner inputs view, remix source, and paid-bundle recipe
inputs. For those generations the staged file is load-bearing, not garbage.

Two mechanisms handle this, both inside the `media-upload-reclaim` job:

- **The guard** loads every staged path named by a generation with no durable
  rows and refuses to reclaim it, counted as `protectedLegacyReferences`. It is
  path-based rather than consumption-based on purpose: a repair that persists
  and then rolls back leaves an intent marked consumed while its generation is
  legacy-only again. If the guard scan fails or looks truncated, the run
  reclaims **nothing** — an unproven answer never authorises a delete.
- **The repair** runs first each night, healing up to five such generations by
  persisting exactly what the legacy view renders. It is all-or-nothing per
  generation: a partial set would *degrade* the view, because the read paths flip
  to durable rows the moment one exists, so an incomplete repair deletes its own
  rows (before its objects — a row whose object is missing blocks account
  deletion) and records a failed attempt. After three attempts a generation is
  left alone permanently and stays guarded. Cross-user source references are a
  terminal skip: those bytes cannot be copied into this owner's bucket.

Watch `repair.completed` / `repair.failed` and `protectedLegacyReferences`.
`protectedLegacyReferences` should fall toward zero as repairs land; a number
that stops falling means repair is stuck on something worth reading the logs for.

### Rollout order

1. Ship the server side. Watch `repair.*` and `protectedLegacyReferences` drain.
2. Backfill the pre-migration backlog once, so the sweep can see it at all:
   `npm run backfill:media-upload-intents` (dry run) then
   `-- --execute --project-ref=<ref>`. It re-derives categories at run time,
   seeds only durable-backed objects as consumed, and reports both directions of
   `generation_inputs` drift without changing anything.
3. Ship mobile `0.0.5` with draft-media verification through
   `mobile-store-release`. Do not start the adoption clock until both TestFlight
   and closed Alpha are installable and one tester has installed and opened each
   platform build.
4. Allow a 72-hour adoption window and confirm every current internal tester has
   installed and opened `0.0.5`.
5. In a separate reviewed change, raise the code-controlled
   `minimumAppVersion` to `0.0.5`. Verify `/api/app-version`, a real `0.0.4`
   forced-update flow, HTTP 426 for identified `0.0.4` API requests, and normal
   access for `0.0.5`, web, and unidentified clients. Observe production for 24
   hours. Rolling the minimum back below `0.0.5` disables abandoned reclaim even
   if the environment flag remains set.
6. **Check the deletion preconditions** across at least three healthy daily
   reclaim runs: no rollback failures, no unverifiable guard skips, and
   `protectedLegacyReferences` is zero or the stable attempt-exhausted remainder
   is documented and understood.
7. Set `MEDIA_UPLOAD_RECLAIM_ABANDONED=true` in Vercel Production, then run the
   guarded configuration-only redeployment with
   `expected_abandoned_reclaim_effective=true`. The environment edit alone does
   not change the running application.
8. Monitor `reclaimed`, `rowsDropped`, `bytesReclaimed`, repair results,
   `protectedLegacyReferences`, and `storage_cleared_at` until the eligible
   tracked backlog reaches zero. Re-run the backfill dry run and durable-copy
   drift report. Do not delete an uploads folder or wildcard; any exceptional
   cleanup must use an explicitly reviewed exact-path manifest.

To roll back, unset the variable and run the guarded configuration-only
redeployment with `expected_abandoned_reclaim_effective=false`; the consumed half
and the repair keep running. Removing the variable without redeploying does not
disable it in the already-built deployment.

## Durable Queue Graduation Decision

Current decision: keep the Vercel cron orchestrator for `account-deletion-resweeps`, `backend-alert-delivery`, `feed-maintenance`, `generation-completions`, `generation-model-verification`, `media-preview-repair`, `media-upload-reclaim`, `mobile-push-receipts`, `operational-data-retention`, and `referral-reward-reconciliation`.

This is the cost-efficient production baseline for the current workload because the jobs are idempotent, lock-protected in Supabase, bounded by 300-second function limits, and tolerant of the current ten-minute or hourly cadence. The single `/api/cron/backend-jobs` scheduler keeps Vercel cron invocations at 144 per day while logical jobs can still run at their own cadence.

Graduate a job to a durable queue or workflow service only when one of these conditions is repeatedly true after provider incidents and obvious configuration faults are ruled out:

- User-facing completion needs become sub-five-minute instead of eventually consistent.
- A job spends more than 70% of `maxDuration` for three consecutive healthy scheduler runs.
- Pending work stays older than two health windows for the same job after two scheduler intervals.
- The job needs parallel workers, per-item retries, or poison-message isolation that would make one cron tick risky.
- A job's retries or polling cost becomes material in `/api/ops/backend-costs` compared with the cost of durable queue infrastructure.

Until one of those thresholds is met, prefer optimizing the current path first: tighter batch sizes, better indexes, provider timeout tuning, and clearer backend alerts.

### Payments And Webhooks

- Send provider dashboard test webhooks for KIE, Razorpay, and RevenueCat.
- Confirm invalid signatures receive `401` and valid test events are accepted idempotently.
- In Razorpay, subscribe the production endpoint to `payment.captured`, `refund.processed`, and the `payment.dispute.*` lifecycle events. Referral and base-credit reversals use provider cumulative amounts, so do not substitute a custom one-off refund callback.
- In RevenueCat, keep `CANCELLATION` and `REFUND_REVERSED` enabled for credit products; verified purchases are also settled through the signed mobile purchase-sync path.
- Confirm RevenueCat no longer returns `Webhook is not configured.`
- Verify payment and refund reconciliation in Supabase without relying only on the provider dashboard.
- Confirm the referral reward reconciliation job has no unsettled verified credit purchases before release promotion.

### App Links

```bash
curl -fsS https://magicbooklet.com/.well-known/apple-app-site-association
curl -fsS https://magicbooklet.com/.well-known/assetlinks.json
```

- Confirm both association documents return `200` directly over HTTPS without a redirect and contain the production app identifiers/signing fingerprints.
- Confirm the AASA `paths` list matches `contracts/universal-links-v1.json` — currently `/r/*`, `/showcase/*`, and `/creators/*`. The Android side of the same contract lives in `ugc-mobile/app.json` `intentFilters`, one entry per path family.
- Open a real `/r/<code>`, `/showcase/<id>`, and `/creators/<username>` link on desktop, iOS, and Android. Confirm the web fallback works everywhere, and that installed apps open the native route rather than the browser.
- **Test iOS on a fresh install.** Apple's CDN caches the association document, so a device that already has the app may keep the previous, narrower path list for a while. A link that still opens Safari on an existing install is not evidence the change failed.

### Invite And Earn

- Complete a new-account referral in the release environment, then make one verified test credit-pack purchase. Confirm the invitee receives the one-time 5% promotional bonus and the inviter receives 5% promotional credits.
- Refund that test purchase through the provider, then restore/reverse the refund when the provider supports it. Confirm base and referral balances change atomically and notification entries use one idempotent provider event key.
- Confirm promotional credits can fund creation but do not increase paid-credit marketplace spending power.

### Mobile Compatibility

- Open Create Media with the released mobile build and confirm catalog refresh, quote, and generation still work.
- Test an offline cached catalog and a retired-model draft.
- Exercise mobile purchase restore and notification registration.
- Do not remove an API field or model schema version while a released mobile client still depends on it.

The shared API treats requests without mobile compatibility headers as legacy API v1. The current mobile release advertises app, API, and catalog schema versions on every request. To retire an old client safely:

1. Deploy support for the new API/catalog behavior while the minimum versions still allow the released client.
2. Ship the mobile update and monitor adoption plus `MOBILE_UPDATE_REQUIRED` responses.
3. Raise `minimumApiVersion` or `minimumAppVersion` only after the support window has elapsed.
4. Keep the stable `426 MOBILE_UPDATE_REQUIRED` response and compatibility policy available to retired clients.
5. Never ship a mobile API/catalog version before the backend supports it; a future version receives retryable `409 MOBILE_SERVER_UPDATE_REQUIRED`.

## Rollback

### Application Rollback

Use Vercel rollback or promote the last known-good deployment. Verify custom domains, runtime logs, cron definitions, cache headers, and health immediately afterward.

### Database Recovery

Production migrations are forward-only. Do not run destructive down migrations during an incident. Prefer a corrective additive migration, restore a feature flag/default, or temporarily disable the affected route.

Supabase scheduled daily physical database backups are active for the production
project. They provide a database recovery point with a worst-case recovery point
objective of roughly 24 hours. Point-in-time recovery is available only as a
paid provider add-on and is not enabled for the lean launch.

Supabase database backups do not restore deleted Storage objects. There is no
independent Storage backup for the lean launch, so accidental or malicious
deletion of uploaded/generated media may be irreversible. This is an explicitly
accepted launch risk. During a real incident, freeze writes, preserve provider
webhooks, contact Supabase support when appropriate, restore the selected
database backup into an isolated project first, and prefer forward corrective
migrations over destructive rollback.

### Provider And Spend Containment

- Disable the affected generation model in the server catalog before removing provider code.
- Preserve pending generation records and credit settlement history.
- Stop new paid work before interrupting reconciliation jobs.
- Keep webhook endpoints available during provider incidents so delayed events can still reconcile.

## Alert Response Guide

| Signal | Initial threshold | Immediate response |
| --- | --- | --- |
| Failed generation settlement | Any unreconciled paid generation older than 15 minutes | Disable affected model if systemic, inspect provider task and idempotency record, reconcile or refund. |
| Stalled active generation (`GENERATION_STALLED_ACTIVE`, `GENERATION_PENDING_WITHOUT_PROVIDER_TASK`) | Any active generation older than 60 minutes, or pending without a provider task after 5 minutes | Remediation is automatic: every `generation-completions` tick reaps stalled work in bounded batches — re-polling provider status for stalled `waiting`/`processing` generations that have a provider task (after 30 minutes) and settling/refunding `pending` generations that never received one (after 45 minutes). Follow up manually only if the signal persists across two scheduler intervals: check `stalled_generation_*` log events, KIE webhook forwarding, provider status, and the `generation-completions` job-run ledger. |
| Stale scheduler/job | No healthy run within the job health window | Check cron manifest, `CRON_SECRET`, function logs, job lock expiry, and Supabase connectivity. |
| Payment reconciliation failure | Any failed verified payment/refund event | Stop the affected purchase path if repeated, preserve event payload/id, reconcile idempotently. |
| Provider errors | Five failures or three timeouts in one hour | Check provider status and latency, reduce retries, disable only the affected model/provider when necessary. |
| Media repair backlog | Repairable assets remain after two hourly repair windows | Check storage read/write access, source URL expiry, FFmpeg/runtime limits, and job locks. |
| `MEDIA_RENDITION_ATTEMPTS_EXHAUSTED` / `MEDIA_PREVIEW_ATTEMPTS_EXHAUSTED` | Rows used all 3 attempts, so the repair sweep skips them and reports "no work" forever | Read `rendition_error` / `preview_error` first — it names the real cause. Fix that, then requeue by clearing the attempt count (see `20260729210000_reset_failed_media_rendition_attempts.sql`). Exhausted video means the feed streams full-size source, so this is an egress cost issue, not only a quality one. |
| `MEDIA_RENDITION_FAILURES` | Renditions failed but retries remain | Usually self-heals within three hourly windows. Watch that it does not escalate to exhausted. |
| `MEDIA_RENDITION_BACKLOG_STALE` | Oldest unresolved rendition older than 6h | Confirm `media-preview-repair` is actually running (not just reporting skipped) and that ffmpeg resolves — `npm run build:verify` gates the bundling failure mode. |
| `ORPHANED_MEDIA_SHELL_POSTS` | Any media/mixed post older than 1 hour with no `post_media` rows | Publishing creates the post private, writes media, then promotes; a failed media write triggers a compensating `posts.delete()` whose own failure is only warned. Read `failed_to_remove_post_after_media_failure` / `failed_to_remove_post_after_source_tool_metadata_failure` logs for the underlying cause. Each row is private with zero media and unreachable by any reader. Before deleting, confirm the matching `failed_to_remove_*` log line exists — a media post from the gallery migration's own release window (2026-06-09) can be a legacy single-asset post rather than a shell. Then delete the `posts` rows — no storage sweep is needed. |
| `SHELL_POST_PROBE_FAILED` | The shell-post probe read could not run | Check grants and policies on `public.posts` and `public.post_media`; the probe reads through a `post_media!left(id)` anti-join and a revoke on either table breaks it. |
| Moderation queue age or volume | Oldest report reaches 4 hours, or 10 reports remain open | Page the staffed moderation role, review the oldest/highest-risk reports first, and follow `docs/moderation-operations.md`. A 24-hour-old report or 25 open reports is degraded. |
| Missing environment capability | Any item in backend health `environment.missing` | Treat as a release blocker for the affected capability and restore the production variable. |
| Spend anomaly | Daily provider spend or failed paid cost exceeds its configured budget | Disable new paid work for the affected provider, preserve reconciliation, and investigate pricing or abuse. |

The protected `/api/ops/backend-dashboard`, `/api/ops/backend-health`, `/api/ops/backend-costs`, and `/api/ops/backend-alerts` endpoints are the canonical operational views. Check the dashboard after each release and on every incident. Configure external alert delivery when you want push notifications to a monitored incident channel.

## Production Alert Delivery Wiring

The internal `/api/ops/backend-dashboard` endpoint is the cost-conscious production dashboarding baseline. It aggregates health, costs, and alerts behind the `Authorization: Bearer $OPS_READ_SECRET` guard and must remain private with `Cache-Control: private, no-store`. The ops endpoints continue to accept `CRON_SECRET` for compatibility, but monitors should use `OPS_READ_SECRET` so read-only checks do not share scheduler credentials.

Optionally wire a monitored destination such as Better Stack, PagerDuty, Slack workflow, or another incident channel through `BACKEND_ALERT_DELIVERY_URL`. The `backend-alert-delivery` logical job runs under the existing `/api/cron/backend-jobs` scheduler, so this does not add another Vercel cron invocation. It posts only warning/degraded summaries by default; set `BACKEND_ALERT_DELIVERY_NOTIFY_OK=true` only when the destination needs explicit recovery events. Use `BACKEND_ALERT_DELIVERY_AUTH_HEADER` when the destination requires an authorization header.

As a secondary check, a monitor may also call `/api/ops/backend-dashboard` or `/api/ops/backend-alerts` with `Authorization: Bearer $OPS_READ_SECRET` after production deployment. Treat non-`2xx` responses as alertable; `503` means the backend is degraded and the response body still contains the normalized dashboard or alert payload.

The endpoint must remain private: expect `Cache-Control: private, no-store`, an `x-request-id`, and no shared-cache hit. Do not expose `OPS_READ_SECRET` or `CRON_SECRET` to browser clients, mobile clients, or public monitor pages.

External alert delivery should route on the stable outbound payload:

- `event`: `backend_alerts`.
- `delivery.severity`: page on `degraded`, notify on `warning`, resolve on explicit `ok` notifications only if enabled.
- `delivery.dedupeKey`: group repeated events without hiding a changed root cause.
- `delivery.summary`: use as the human-readable incident body.
- `delivery.runbookPath`: link responders back to this runbook.
- `delivery.monitorEndpoints`: include the protected follow-up endpoints to inspect.

Use `/api/ops/backend-dashboard` as the primary dashboard feed. Use `/api/ops/backend-health` and `/api/ops/backend-costs` as drill-down panels. Use `/api/ops/backend-alerts` as the paging source because it combines health, cost, spend, provider, scheduler, media, and settlement signals into one normalized contract.

## External Monitoring

**Standing decision: no third-party monitoring services and no paid platform add-ons.** Observability is built from what the existing GitHub, Vercel, and Supabase plans already provide. The accepted blind spots this leaves are recorded below — they are deliberate, not oversights, and should be revisited if the product starts carrying meaningful revenue.

### 1. Watchdog (repository-controlled; activation must be verified)

The scheduler cannot report its own death: alert generation *and* alert delivery both run inside `/api/cron/backend-jobs`, so a dead cron, broken deploy, or bad `CRON_SECRET` silences the very thing that would report it.

`.github/workflows/backend-alert-watchdog.yml` closes that loop. It runs hourly on GitHub's infrastructure — outside Vercel and outside Supabase — and polls the paging endpoint:

```bash
curl -fsS -m 20 \
  -H "Authorization: Bearer $OPS_READ_SECRET" \
  https://magicbooklet.com/api/ops/backend-alerts
```

A failing run sends GitHub's standard workflow-failure email to the repo owner; that email **is** the alert channel. The workflow fails on: no response (platform or deploy down), `401`/`403` (the secret drifted from production), `503` (the app itself reporting degraded health), or any other non-`200`.

**Operator setup — the watchdog fails until this is done.** Add `OPS_READ_SECRET` under *Settings → Secrets and variables → Actions* with the same value as the Vercel Production variable. Without it the workflow exits with an error so missing configuration cannot appear green. Optionally set a valid HTTPS `PRODUCTION_BASE_URL` repository variable to override the default domain. When rotating `OPS_READ_SECRET`, update the GitHub secret before removing `OPS_READ_SECRET_PREVIOUS` from Vercel. A launch sign-off must link a successful manual watchdog run; the workflow file alone is not evidence that monitoring is active.

Cost: each run bills roughly one GitHub Actions minute on a private repo (hourly ≈ 720/month against the 2,000-minute free allowance, leaving headroom for CI); public repos bill nothing. Adjust the `cron:` expression to trade detection latency against minutes.

### 2. `BACKEND_ALERT_DELIVERY_URL` (optional, currently unset)

Outbound alert *push* silently no-ops when unset: the `backend-alert-delivery` job records a skipped run with `alert_delivery_not_configured`. This is acceptable while the watchdog above is the alert channel — the watchdog pulls, so nothing needs to push. If a webhook destination that costs nothing is ever available (a Slack or Discord incoming webhook, for example), set the variable to get faster notification than the hourly poll, and confirm the job reports `succeeded` rather than `skipped` in `/api/ops/backend-dashboard`.

### Accepted blind spots

These are known gaps, consciously left open under the no-third-party, no-paid-add-on decision:

- **No dedicated client error tracking.** Review native iOS crash reports in App
  Store Connect and Android crashes in Google Play Console. Browser exceptions
  and handled mobile JavaScript errors depend on user reports and reproduction.
  Backend faults are covered by `backend-health` and the watchdog.
- **No log drain.** Vercel function logs expire with the plan's retention, so post-incident reconstruction is limited to that window. When an incident happens, capture the relevant logs *before* they age out. The app emits single-line structured JSON via `backend-logger`, so copying the raw lines out of the Vercel log view preserves everything needed.
- **No PITR until the paid provider add-on is activated.** Supabase scheduled
  physical database backups have a daily RPO; they are not continuous recovery.
- **No independent Storage recovery.** Supabase database backups do not cover
  Storage objects, and the lean launch has no off-platform media backup.
- **No mobile OTA channel.** Every client fix requires a store release; the server-side 426 gate is the only fast lever, and it can only push users toward a build that must already be approved.

## Performance Monitoring And Load Budgets

Vercel Speed Insights is the canonical browser real-user monitoring source. Enable Speed Insights for the `ugc-app` Vercel project first, then set `NEXT_PUBLIC_SPEED_INSIGHTS_ENABLED=1` and redeploy. The root layout deliberately injects no monitoring script while that flag is absent, which prevents a failed script request when the paid project feature is disabled. `NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE` controls the collection ratio (default `1`). Review production mobile and desktop data separately. The release budgets in `config/performance-budgets.json` use the standard P75 Core Web Vitals thresholds: LCP at most 2.5 seconds, CLS at most 0.1, INP at most 200 milliseconds, FCP at most 1.8 seconds, and TTFB at most 800 milliseconds.

The read-only production load harness measures both TTFB and complete response time, records the Vercel cache status, enforces target-specific P95/P99/error-rate budgets, caps normal edge runs at 300 seconds, concurrency 20, and 50 requests per second, and never exercises mutations, authentication, generation providers, payments, or webhooks. The default rate cap is 25 requests per second. Production access requires an explicit opt-in.

Run a ten-second smoke locally:

```bash
PERF_ALLOW_PRODUCTION=1 npm run perf:load:smoke
```

Run the default 30-second bounded check and retain a machine-readable report:

```bash
PERF_ALLOW_PRODUCTION=1 npm run perf:load -- --output performance-load-results.json
```

The `Production Performance` GitHub workflow runs for 90 seconds at concurrency 4 every Monday and can also be dispatched manually. Any error-rate, minimum-sample, P95, or P99 violation fails the workflow and its job summary identifies the affected route. The full JSON report is retained as an artifact for 30 days. Treat a single failure as an investigation trigger; treat two consecutive failures as a release blocker until the regression or upstream incident is understood.

The same workflow runs three Lighthouse samples for `/`, `/showcase`, and `/marketplace` under both mobile and desktop emulation, applying the network and CPU constraints directly in Chrome so streamed server content is measured from the browser trace. Median LCP, CLS, FCP, server response time, and Total Blocking Time must meet the budgets in `config/performance-budgets.json`; Lighthouse Total Blocking Time is the lab responsiveness proxy because INP requires real-user interaction data. The performance score is an advisory warning, while the individual user-centric metrics are release gates. HTML and JSON reports are retained for 30 days. Run one local production audit with `LHCI_FORM_FACTOR=mobile PERF_LIGHTHOUSE_RUNS=1 npm run perf:lighthouse`.

The scheduled `edge` profile validates the experience users receive through Vercel and application caches. It is not a database saturation test. Reports retain `x-vercel-cache`, `age`, `cache-control`, and `x-matched-path` observations and summarize edge-served (`HIT`, `STALE`, `REVALIDATED`) separately from naturally origin-served (`MISS`, `BYPASS`) latency. This keeps production misses visible without deliberately defeating production caches.

The cache-bypassing `origin` profile is restricted to localhost backed by an isolated non-production dataset. Every remote hostname is rejected, requests do not follow redirects, and the explicit non-production-data acknowledgement is mandatory. It uses only the viewer-neutral recent showcase feed, a unique cache key, a duration of at most 60 seconds, concurrency at most 2, and at most 2 requests per second. Localhost accepts the absent Vercel cache header.

```bash
PERF_ALLOW_ORIGIN_LOAD=1 PERF_ORIGIN_NON_PRODUCTION_DATA=1 \
  PERF_BASE_URL=http://localhost:3000 \
  npm run perf:load -- --profile origin --duration-seconds 30 --concurrency 1 \
  --output performance-load-results.json
```

Use Vercel Speed Insights for field regressions and the scheduled workflow for synthetic latency regressions. Configure Vercel project error/usage alerts and spend management when available on the active plan; the repository-owned workflow remains the plan-independent latency alert.

## Routine Review

- Weekly: provider failures, paid-generation refunds, job health, storage growth, and bandwidth-heavy reads.
- Monthly: unused-index evidence after a representative traffic window, dependency audit, provider pricing, model retirement, and mobile API compatibility.
- Before scaling compute: verify function/database region alignment, query plans, connection strategy, and measured saturation. Do not increase compute as the first response to application-level inefficiency.
