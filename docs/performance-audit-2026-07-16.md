# Cross-Platform Performance Audit

Date: 2026-07-16

## Executive verdict

The release candidate is close to the practical ideal for the current Vercel, Supabase, Next.js, and Expo architecture. The material code-level performance and backend-safety gaps found in this audit have been fixed. The remaining gaps are operational evidence that requires production traffic, paid real-user monitoring, or physical release hardware rather than another source-code optimization pass.

Pre-deployment rating: **9.5/10**.

| Area | Rating | Decision |
| --- | ---: | --- |
| Backend correctness and security | 9.7/10 | Reviewed migration applied and live privilege/masking probes passed. |
| Backend read performance | 9.6/10 | Query amplification removed from the critical public feeds; bounded compatibility fallbacks remain. |
| Web performance | 9.6/10 | All local mobile and desktop Lighthouse release budgets pass over three runs per route. |
| Mobile implementation | 9.2/10 | SDK, startup telemetry, tests, exports, and native builds pass; physical-device traces remain an external gate. |
| Observability and regression control | 9.1/10 | Synthetic and load gates are automated; field P75 INP/LCP requires production RUM to be enabled. |

## Scope and method

The audit covered:

- Public backend reads, database projections, RLS boundaries, RPC grants, schema-rollout compatibility, and pagination behavior.
- Next.js server rendering, above-the-fold streaming, media delivery, font loading, image optimization, and route-level cache behavior.
- Production-safe edge load testing with P95/P99 budgets and cache observations.
- Mobile dependency alignment, startup readiness, JavaScript bundles, iOS/Android native builds, and physical-device profiling automation.
- Dependency security, full unit/integration regression suites, type checking, linting, migration replay coverage, and CI release gates.

Synthetic browser results are three-run medians. They apply network and CPU constraints in Chrome. They are release-gate evidence, not a substitute for field P75 Core Web Vitals.

## Performance evidence

### Production edge baseline before deployment

The bounded 60-second production read test completed 1,499 requests with zero errors. It exercised only anonymous, read-only pages and APIs.

| Target | P95 TTFB | P99 TTFB | P95 total | P99 total |
| --- | ---: | ---: | ---: | ---: |
| Home page | 181.3 ms | 290.7 ms | 220.3 ms | 364.2 ms |
| Showcase page | 204.3 ms | 500.0 ms | 309.0 ms | 737.5 ms |
| Marketplace page | 195.3 ms | 461.9 ms | 268.3 ms | 773.6 ms |
| Generation model catalog | 186.6 ms | 385.6 ms | 194.5 ms | 388.9 ms |
| Showcase feed API | 191.8 ms | 371.3 ms | 206.3 ms | 479.2 ms |

All target-specific P95, P99, minimum-sample, status, and error-rate budgets passed.

### Final local mobile Lighthouse medians

| Route | Score | FCP | LCP | TTFB | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 0.99 | 1,779 ms | 1,779 ms | 11.6 ms | 0 ms | 0 |
| `/marketplace` | 0.98 | 1,754 ms | 2,038 ms | 6.6 ms | 1.9 ms | 0 |
| `/showcase` | 0.98 | 1,696 ms | 2,019 ms | 11.3 ms | 0 ms | 0 |

### Final local desktop Lighthouse medians

| Route | Score | FCP | LCP | TTFB | TBT | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 1.00 | 157 ms | 157 ms | 10.0 ms | 0 ms | 0.00004 |
| `/marketplace` | 1.00 | 88 ms | 169 ms | 6.6 ms | 0 ms | 0 |
| `/showcase` | 1.00 | 108 ms | 170 ms | 13.4 ms | 0 ms | 0 |

All 18 final Lighthouse reports passed the configured FCP, LCP, TTFB, CLS, TBT, interactive, and score assertions.

An earlier production audit identified LCP as the main frontend gap: approximately 4.06 seconds on home, 3.63 seconds on marketplace, and 3.51 seconds on showcase. The final numbers are not a strict apples-to-apples comparison because the final gate uses browser-applied throttling to correctly measure already-painted streamed server content, while the earlier run used Lighthouse's simulated dependency model. The earlier audit still correctly located the slow rendering and oversized-media paths that were fixed.

## Backend changes completed

### Public feed hydration

- Consolidated post resource-bundle summaries into one service-role RPC instead of repeated per-card reads.
- Added request-scoped hydration reuse for overlapping ranked and fallback showcase results.
- Added summary/count hydration that does not sign or transfer source media URLs when callers do not need them.
- Kept actual remix flows on the URL-bearing path so optimization does not change behavior.

### Paid-content boundary

- Removed the public RLS policy that exposed complete published resource-bundle rows, including paid prompt, workflow, and file payloads.
- Replaced it with authenticated owner-only direct reads.
- Restricted the new `SECURITY DEFINER` summary RPC to `service_role`; public, anonymous, and authenticated execution is revoked.
- CASE-masked every sensitive summary field for non-published rows. Draft rows expose only their post identifier and status to the backend projection.
- Made bundle-presence and missing-schema error paths fail closed so a database error cannot synthesize a free recipe for a potentially paid post.

### Rollout and pagination safety

- Added a rolling-deploy fallback when the summary/list RPC is temporarily missing.
- The fallback first verifies database publication state and only then reads detailed published rows.
- Marketplace fallback reads use stable ordering and 24–96-row batches.
- Public marketplace offsets above 960 are rejected with `400`; pagination never advertises a next offset beyond that boundary.
- The missing-RPC compatibility path has a hard 1,009-row total scan/hydration ceiling, preventing a selective query from walking an unbounded catalog.

## Web changes completed

- Streamed static home and marketplace hero content immediately while database-backed sections resolve behind Suspense boundaries.
- Kept the first mobile home creator card on a stable branded visual so a late remote image cannot replace the painted hero as LCP.
- Removed unnecessary above-the-fold entrance animation from the home hero.
- Routed eligible preview images through the Next.js image optimizer only for safe same-origin or configured Supabase Storage URLs.
- Reused the same optimizer decision in still-image and hover-video components.
- Added optimized marketplace previews and a stable card media frame, eliminating the earlier multi-megabyte raw image path.
- Optimized and preloaded the priority showcase poster.
- Kept Geist non-blocking with optional display and no font preload.

## Mobile changes completed

- Upgraded to Expo SDK 55, React Native 0.83.6, and React 19.2 with aligned dependencies.
- Added Expo Observe startup instrumentation and a single readiness mark after auth/onboarding routing and minimum-version handling, with a bounded fallback.
- Added configuration patches for the workspace path and production native autolinking behavior.
- Added a physical Android profiler that validates the device, package, signature, and non-debuggable release state before collecting independent cold/hot startup and frame metrics.
- Added CI prebuild plus separate production iOS and Android Hermes exports.
- Verified clean CocoaPods resolution and an unsigned arm64 iOS Simulator Release build.
- Verified mobile dependency alignment, Expo Doctor, tests, TypeScript, and zero dependency vulnerabilities.

## Regression controls added

- Repository-owned P95/P99 production read budgets with global RPS, concurrency, duration, warmup, redirect, host, and request-timeout limits.
- A localhost-only origin profile that requires an explicit non-production-data acknowledgement and cannot target a remote host.
- Weekly and manually dispatchable production performance CI.
- Sequential mobile/desktop Lighthouse matrices with three samples per page and retained reports.
- CI checks that replay every Supabase migration in an isolated database.
- Conditional Vercel Speed Insights integration that injects no client script until the project feature is explicitly enabled.

## Verification summary

- Web: 448 test files and 2,290 tests passed after the final pagination hardening.
- Mobile: 74 test files and 557 tests passed.
- Web and mobile TypeScript checks passed.
- ESLint passed.
- Expo dependency alignment passed.
- Expo Doctor passed 19/19 checks.
- Web and mobile dependency audits reported zero vulnerabilities, including development dependencies.
- Performance load-harness and Lighthouse-configuration self-tests passed.
- Supabase linked migration dry-run identified only the reviewed migration; it was then applied and production history aligned at 107 migrations.
- A live privilege probe confirmed anonymous RPC execution is denied with PostgreSQL code `42501` while `service_role` receives a successful response.
- A live non-published-row probe confirmed status is preserved while every sensitive field is null-masked.
- The local database replay was unavailable because Docker was not running; the repository's isolated Supabase CI replay remains the authoritative clean-database gate.

## Remaining external gates

These are not unresolved code findings:

1. Enable the paid Vercel Speed Insights project feature, then set `NEXT_PUBLIC_SPEED_INSIGHTS_ENABLED=1`, to measure field P75 LCP/INP/CLS. Synthetic TBT is only an INP proxy.
2. Run the Android physical-device profiler against a signed, non-debuggable distribution-equivalent APK. A locally debug-keystore-signed release build is suitable for build validation, not store-signing validation.
3. Capture iOS launch and memory evidence on a physical release device and create a signed App Store archive when distribution credentials are available.
4. Confirm Expo Observe startup samples after the new mobile binary reaches real users.
5. Monitor production backend health, errors, cache behavior, and provider/settlement alerts for at least one scheduler interval after deployment.

## Rating interpretation

A 10/10 rating would imply proven performance under representative production field traffic, physical-device release traces on both platforms, verified store signing, and no remaining operational uncertainty. Those claims cannot be established from source code or simulators alone. At 9.5/10, the application has strong architecture, bounded failure modes, automated regression budgets, and clean release evidence while preserving a small, explicit set of real-world validation gates.
