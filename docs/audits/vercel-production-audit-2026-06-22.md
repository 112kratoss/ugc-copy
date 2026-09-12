# Vercel Production Audit

Date: 2026-06-22
Project: `athuls-projects-2ab559ed/ugc-app`
Project ID: `prj_TBY250WgPgMEgGldfohaHyaHjkcn`

## Verified Live State

- Plan: Pro.
- Framework: Next.js.
- Node.js: 24.x, compatible with the repository engine range `>=22 <25`.
- Fluid Compute: enabled.
- Default function region: `iad1` (Washington, D.C.).
- Supabase region: `ap-south-1` (Mumbai).
- Production branch: `main`.
- Git deployments: enabled.
- Custom domains: `magicbooklet.com` and `www.magicbooklet.com`.
- Production function timeout default: 300 seconds.
- Runtime log/trace drains: none configured.
- Git fork protection: enabled.

## Findings

### 1. Function And Database Region Mismatch

Production function execution is in `iad1` while Supabase is in Mumbai. A live request returned an `x-vercel-id` path containing `bom1::iad1`, showing Mumbai ingress followed by Washington function execution. This adds cross-continent latency to database-backed API requests.

Local remediation is complete: `vercel.json` now pins Fluid Compute functions to `bom1`, and a regression test enforces it. Production remains open until that revision is deployed and the live execution region is verified.

### 2. Stale Cron Manifest

The live deployment still defines three cron routes:

- `/api/cron/generation-completions` every ten minutes.
- `/api/cron/media-preview-repair` hourly.
- `/api/cron/mobile-push-receipts` every fifteen minutes.

The current repository consolidates these behind `/api/cron/backend-jobs` every ten minutes, reducing scheduled invocations and centralizing locks and health. Production remains open until deployment.

### 3. Missing RevenueCat Webhook Authorization

Production does not contain `REVENUECAT_WEBHOOK_AUTH_TOKEN`. A live unauthenticated smoke request returned `503` with `Webhook is not configured.` Refund and revocation webhook reconciliation cannot operate until the same authorization value is configured in Vercel and RevenueCat.

No secret value was read or recorded during this audit.

### 4. Duplicate Production Deployments

Recent commits produced pairs of production deployments: one Git-created deployment and one manual/Codex deployment with the same commit SHA. Normal releases must use the Git integration only. Manual `vercel --prod` deployment is reserved for recovery.

### 5. Deployed Cache Policy Is Behind Local Hardening

Unauthorized private endpoint smoke tests currently return `Cache-Control: public, max-age=0, must-revalidate`. Vercel reported cache misses, but private responses should explicitly use `private, no-store`. The current repository applies that policy and now has a repository-wide mutation-route regression test. Production remains open until deployed and re-tested.

The public generation catalog correctly returns an `ETag` and five-minute public caching in the deployed revision. The current repository also adds stale revalidation.

### 6. Alert Delivery Is Not Externalized

Protected backend health, cost, and alert endpoints exist locally, but no Vercel drain or external alert destination is configured. This is acceptable for pre-launch verification but not for unattended production operations.

## Local Remediation Completed

- Added `$schema`, `fluid: true`, and `regions: ["bom1"]` to `vercel.json`.
- Added a test that locks Vercel compute to Supabase Mumbai.
- Added a value-free backend environment contract and health signal.
- Added missing production variable names to `.env.example`.
- Added a static guarantee that all mutating API responses use private no-store handling.
- Added the production deployment and operations runbook.

## Remaining Production Actions

1. Configure `REVENUECAT_WEBHOOK_AUTH_TOKEN` in Vercel and the matching RevenueCat webhook header.
2. Commit and push the verified revision once; do not run a second production deployment.
3. Confirm one production deployment, `bom1` execution, one consolidated cron, complete environment health, and private no-store headers.
4. Connect backend alerts to a monitored destination or configure an external observability integration.
5. Consider enabling Vercel Speed Insights after the backend cutover to establish a user-facing performance baseline.
