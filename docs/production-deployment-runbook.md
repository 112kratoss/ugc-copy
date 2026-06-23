# Production Deployment And Operations Runbook

Last updated: 2026-06-23

## Production Topology

- Web and shared API: Vercel Pro project `ugc-app`.
- Function region: `bom1` (Mumbai), version-controlled in `vercel.json`.
- Database, Auth, and Storage: Supabase Pro project `ildfmhozpibwiopeavfg` in `ap-south-1` (Mumbai).
- Production branch: `main`.
- Production domains: `magicbooklet.com` and `www.magicbooklet.com`.
- Background scheduler: `/api/cron/backend-jobs` every ten minutes.

Vercel Git integration owns normal production deployments. Do not also run `vercel --prod` for the same commit. Manual production deployment is reserved for recovery when Git deployment is unavailable and must be recorded in the change history.

## Required Environment Contract

The protected backend health endpoint reports only missing capability names, never values. Production requires:

- Supabase URL: `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`.
- Supabase client key: `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Supabase privileged key: `SUPABASE_SERVICE_ROLE_KEY`.
- Canonical origin: `NEXT_PUBLIC_SITE_URL`.
- Scheduler authentication: `CRON_SECRET`.
- Generation provider: `KIE_AI_API_KEY`.
- Generation webhook authentication: `KIE_WEBHOOK_HMAC_KEY` or legacy `WEBHOOK_SECRET`.
- Razorpay: `NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.
- RevenueCat: `REVENUECAT_SECRET_API_KEY` or `REVENUECAT_REST_API_KEY`, plus `REVENUECAT_WEBHOOK_AUTH_TOKEN`.

Keep secrets scoped to Production unless a separate preview environment has isolated provider credentials and an isolated database. Never connect untrusted preview branches to production service-role credentials.

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
npx --yes vercel@latest env ls production --format=json
```

7. Confirm Supabase security and performance advisors. Leaked-password protection must be enabled before broad public launch. Use percentage-based Auth database connections before increasing compute size.

## Deployment Order

1. Keep schema changes additive and compatible with the currently released web and mobile clients.
2. Apply reviewed Supabase migrations with `supabase db push --linked --yes`.
3. Re-run migration parity and critical metadata checks.
4. Commit and push the verified code to `main` once.
5. Allow the Git integration to create the production deployment. Do not start a second CLI deployment for the same commit.
6. Wait for the deployment to reach `READY` and confirm the production alias points to the expected commit.
7. Run the post-deployment smoke tests below.
8. Monitor runtime errors, backend alerts, provider failures, and payment reconciliation for at least one scheduler interval.

## Post-Deployment Smoke Tests

Store `CRON_SECRET` in a temporary shell environment without printing it. Do not place the value in documentation or command history.

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
  -H "Authorization: Bearer $CRON_SECRET" \
  https://magicbooklet.com/api/ops/backend-health

curl -sS \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://magicbooklet.com/api/ops/backend-alerts
```

Expect a configured environment, a current build id, no stale scheduler, no settlement backlog, and no missing required capability. A degraded response blocks release promotion until understood.

## Durable Queue Graduation Decision

Current decision: keep the Vercel cron orchestrator for `generation-completions`, `media-preview-repair`, and `mobile-push-receipts`.

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
- Confirm RevenueCat no longer returns `Webhook is not configured.`
- Verify payment and refund reconciliation in Supabase without relying only on the provider dashboard.

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

Production migrations are forward-only. Do not run destructive down migrations during an incident. Prefer a corrective additive migration, restore a feature flag/default, or temporarily disable the affected route. Use point-in-time recovery only for confirmed data loss or corruption and coordinate it with an application write freeze.

### Provider And Spend Containment

- Disable the affected generation model in the server catalog before removing provider code.
- Preserve pending generation records and credit settlement history.
- Stop new paid work before interrupting reconciliation jobs.
- Keep webhook endpoints available during provider incidents so delayed events can still reconcile.

## Alert Response Guide

| Signal | Initial threshold | Immediate response |
| --- | --- | --- |
| Failed generation settlement | Any unreconciled paid generation older than 15 minutes | Disable affected model if systemic, inspect provider task and idempotency record, reconcile or refund. |
| Stale scheduler/job | No healthy run within the job health window | Check cron manifest, `CRON_SECRET`, function logs, job lock expiry, and Supabase connectivity. |
| Payment reconciliation failure | Any failed verified payment/refund event | Stop the affected purchase path if repeated, preserve event payload/id, reconcile idempotently. |
| Provider errors | Five failures or three timeouts in one hour | Check provider status and latency, reduce retries, disable only the affected model/provider when necessary. |
| Media repair backlog | Repairable assets remain after two hourly repair windows | Check storage read/write access, source URL expiry, FFmpeg/runtime limits, and job locks. |
| Missing environment capability | Any item in backend health `environment.missing` | Treat as a release blocker for the affected capability and restore the production variable. |
| Spend anomaly | Daily provider spend or failed paid cost exceeds its configured budget | Disable new paid work for the affected provider, preserve reconciliation, and investigate pricing or abuse. |

The protected `/api/ops/backend-health`, `/api/ops/backend-costs`, and `/api/ops/backend-alerts` endpoints are the canonical operational views. Connect alert delivery to a monitored destination before broad public launch; until then, check them after each release and on every incident.

## Production Alert Delivery Wiring

Wire a monitored destination such as Better Stack, PagerDuty, Slack workflow, or another incident channel to call `/api/ops/backend-alerts` with `Authorization: Bearer $CRON_SECRET` after production deployment. Treat non-`2xx` responses as alertable; `503` means the backend is degraded and the response body still contains the normalized alert payload.

The endpoint must remain private: expect `Cache-Control: private, no-store`, an `x-request-id`, and no shared-cache hit. Do not expose `CRON_SECRET` to browser clients, mobile clients, or public monitor pages.

External alert delivery should route on the stable `delivery` object:

- `delivery.severity`: page on `degraded`, notify on `warning`, resolve on `ok`.
- `delivery.dedupeKey`: group repeated events without hiding a changed root cause.
- `delivery.summary`: use as the human-readable incident body.
- `delivery.runbookPath`: link responders back to this runbook.
- `delivery.monitorEndpoints`: include the protected follow-up endpoints to inspect.

Use `/api/ops/backend-health` and `/api/ops/backend-costs` as dashboard panels. Use `/api/ops/backend-alerts` as the paging source because it combines health, cost, spend, provider, scheduler, media, and settlement signals into one normalized contract.

## Routine Review

- Weekly: provider failures, paid-generation refunds, job health, storage growth, and bandwidth-heavy reads.
- Monthly: unused-index evidence after a representative traffic window, dependency audit, provider pricing, model retirement, and mobile API compatibility.
- Before scaling compute: verify function/database region alignment, query plans, connection strategy, and measured saturation. Do not increase compute as the first response to application-level inefficiency.
