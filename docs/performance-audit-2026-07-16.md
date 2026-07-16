# Cross-Platform Performance Audit

Date: 2026-07-16

## Executive verdict

All reproducible code-level performance and backend-safety findings in scope are resolved and regression-protected. Runtime commit [`4f021e871f673b092cc1c925e93ff6605dc4259b`](https://github.com/112kratoss/ugc-copy/commit/4f021e871f673b092cc1c925e93ff6605dc4259b) is deployed to production and passed both the exact-commit Quality workflow and the bounded Production Performance workflow. The remaining gaps require field traffic, physical release devices, or distribution credentials rather than another source-code optimization pass.

Post-deployment rating: **9.6/10**. This is a risk-weighted release rating, not a simple average.

| Area | Rating | Decision |
| --- | ---: | --- |
| Backend correctness and security | 9.8/10 | Live privilege/masking probes and the exact-release clean migration replay passed. |
| Backend read performance | 9.7/10 | Query amplification is removed and all post-deployment P95/P99 production budgets pass with zero errors. |
| Web performance | 9.8/10 | All 18 production Lighthouse reports pass the mobile and desktop release gates. |
| Mobile implementation | 9.3/10 | SDK, startup telemetry, tests, exports, and the release APK pass; physical-device traces remain external. |
| Observability and regression control | 9.2/10 | Synthetic and load gates are automated; field P75 INP/LCP still requires production RUM. |

### Release evidence

| Evidence | Result |
| --- | --- |
| Runtime commit | `4f021e871f673b092cc1c925e93ff6605dc4259b` |
| Vercel deployment | `dpl_2yN9v47fnotDBJ1Wu2dKWcqx9tuZ`, READY, production aliases attached |
| GitHub deployment | `5468481060`, success for the exact runtime SHA |
| Quality workflow | [Run 29474247410](https://github.com/112kratoss/ugc-copy/actions/runs/29474247410), Web/Mobile/Supabase replay all green |
| Production Performance | [Run 29474661561](https://github.com/112kratoss/ugc-copy/actions/runs/29474661561), load/mobile/desktop all green |
| Evidence completed | 2026-07-16 05:54:24 UTC |

## Scope and method

The audit covered:

- Public backend reads, database projections, RLS boundaries, RPC grants, schema-rollout compatibility, and pagination behavior.
- Next.js server rendering, above-the-fold streaming, media delivery, font loading, image optimization, and route-level cache behavior.
- Production-safe edge load testing with P95/P99 budgets and cache observations.
- Mobile dependency alignment, startup readiness, JavaScript bundles, iOS/Android native builds, and physical-device profiling automation.
- Dependency security, full unit/integration regression suites, type checking, linting, migration replay coverage, and CI release gates.

Synthetic browser results are three-run medians. They apply network and CPU constraints in Chrome. They are release-gate evidence, not a substitute for field P75 Core Web Vitals.

## Performance evidence

### Post-deployment production edge result

The bounded 90-second production read test completed 1,323 anonymous, read-only requests with zero failures and no budget violations.

| Target | Requests | P95 TTFB | P99 TTFB | P95 total | P99 total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home page | 332 | 155.7 ms | 396.3 ms | 162.8 ms | 400.7 ms |
| Showcase page | 166 | 543.6 ms | 592.0 ms | 1,280.9 ms | 1,424.1 ms |
| Marketplace page | 165 | 534.8 ms | 760.2 ms | 1,179.7 ms | 1,480.9 ms |
| Generation model catalog | 330 | 63.6 ms | 112.6 ms | 64.0 ms | 113.0 ms |
| Showcase feed API | 330 | 54.3 ms | 123.8 ms | 55.1 ms | 125.0 ms |

The home and API targets were edge-cache hits or stale revalidations. Showcase and marketplace HTML remained origin-rendered so signed-in state and query filters stay correct; both still passed their 1.5/3.0-second TTFB and 2.2/4.0-second total-time budgets under the bounded load.

### Pre-release production edge baseline

The bounded 60-second production read test completed 1,499 requests with zero errors. It exercised only anonymous, read-only pages and APIs.

| Target | P95 TTFB | P99 TTFB | P95 total | P99 total |
| --- | ---: | ---: | ---: | ---: |
| Home page | 181.3 ms | 290.7 ms | 220.3 ms | 364.2 ms |
| Showcase page | 204.3 ms | 500.0 ms | 309.0 ms | 737.5 ms |
| Marketplace page | 195.3 ms | 461.9 ms | 268.3 ms | 773.6 ms |
| Generation model catalog | 186.6 ms | 385.6 ms | 194.5 ms | 388.9 ms |
| Showcase feed API | 191.8 ms | 371.3 ms | 206.3 ms | 479.2 ms |

All target-specific P95, P99, minimum-sample, status, and error-rate budgets passed.

### Final production mobile Lighthouse medians

| Route | Score | FCP | LCP | TTFB | TBT | TTI | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 0.97 | 1,432.8 ms | 1,432.8 ms | 13.6 ms | 187.0 ms | 3,347.2 ms | 0 |
| `/marketplace` | 0.99 | 943.5 ms | 1,218.9 ms | 13.3 ms | 138.6 ms | 2,721.9 ms | 0 |
| `/showcase` | 0.98 | 883.0 ms | 1,393.2 ms | 13.7 ms | 157.1 ms | 2,617.4 ms | 0.0032 |

### Final production desktop Lighthouse medians

| Route | Score | FCP | LCP | TTFB | TBT | TTI | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 0.99 | 800.9 ms | 800.9 ms | 5.9 ms | 0 ms | 813.4 ms | 0.00004 |
| `/marketplace` | 0.99 | 575.9 ms | 854.9 ms | 6.2 ms | 0 ms | 843.2 ms | 0 |
| `/showcase` | 0.98 | 592.9 ms | 1,097.2 ms | 6.6 ms | 0 ms | 909.0 ms | 0 |

All 18 retained reports (three routes times three samples times two form factors) passed the configured median FCP, LCP, TTFB, CLS, TBT, interactive, and score assertions. One cold mobile home sample was noisier than the other two (score 0.82, TBT 506.6 ms), but the route median was 0.97/187.0 ms and every enforced median budget passed. Field RUM remains the correct way to determine whether that variability occurs for real users.

Targeted local single-run diagnostics also confirmed that the real SSR login form reached FCP/LCP at 874/874 ms with 1.6 ms TBT, and the server-bootstrapped template catalog reached 868/882 ms with 1.9 ms TBT. Both had score 1.00 and CLS 0; these diagnostics are not production medians.

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
- Replaced the marketplace's initial full client with a native SSR search/filter surface and three compact cards. Search and filters work without JavaScript; the full buyer browser warms on intent and activates for continuation demand. Mobile filter groups and the search row are width-constrained down to narrow phone viewports.
- Replaced the showcase's anonymous first view with a one-card SSR-compatible bootstrap using the exact priority poster. The full client loads for deep links, card opening, authenticated viewers, or meaningful pointer/keyboard/wheel/touch/scroll demand.
- Deferred anonymous feed personalization until real demand plus an idle window instead of starting it on a fixed six-second timer.
- Added a cookie-name-only auth hint boundary: requests with no hint skip provider/server-auth work, while a hint is never trusted and only causes server verification. A complete signed-out context keeps anonymous consumers stable.
- Server-rendered the real login form after resolving safe redirect/signup/recovery intent, rather than shipping a spinner-only initial document.
- Server-bootstrapped active public templates with five-minute revalidation, removed authoring metadata, retained the public API resilience fallback, and eliminated the duplicate browser fetch.
- Scoped Tailwind to the exact public route import closure and moved private editor/account utilities into a utilities-only route supplement. Route-readiness tests enforce every visual route and both public/private component and dynamic-class closures.
- Enabled inline CSS after scoping so public first paint no longer waits on a stylesheet round trip. The release build's public sheet is approximately 18.4 KiB gzip and the non-public supplement approximately 21.4 KiB gzip.

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

- Web: 455 test files and 2,339 tests passed.
- Mobile: 74 test files and 558 tests passed.
- Web application, operational-script, and mobile TypeScript checks passed.
- Full ESLint passed.
- Expo dependency alignment passed.
- Expo Doctor passed 19/19 checks.
- Web and mobile dependency audits reported zero vulnerabilities, including development dependencies.
- Performance load-harness and Lighthouse-configuration self-tests passed.
- The 124-route production build passed, and packaged FFmpeg remained executable and traced into all 42 required bundles.
- Focused 412px browser checks confirmed `scrollWidth === innerWidth` for login and templates, with the real form/catalog content present. Marketplace's standard mobile profile recorded CLS 0.
- The Android release APK is 93,964,600 bytes, non-debuggable, signed/zipaligned, contains four ABIs, and targets package `com.magicbooklet.mobile` (min/target SDK 24/36). Its SHA-256 is `ed116efb4a72657072efa6d21a1feb43f12c42a4ef7c9a1f7dd5b36a31ae801`; local signing is not store-signing evidence.
- Supabase linked migration dry-run identified only the reviewed migration; it was then applied and production history aligned at 107 migrations.
- A live privilege probe confirmed anonymous RPC execution is denied with PostgreSQL code `42501` while `service_role` receives a successful response.
- A live non-published-row probe confirmed status is preserved while every sensitive field is null-masked.
- The exact-release Quality workflow replayed every migration in an isolated Supabase database and passed the database behavior tests. This CI job is the authoritative clean-database gate; the workstation replay remained unavailable because Docker was not running locally.

## Remaining external gates

These are not unresolved code findings:

1. Enable the paid Vercel Speed Insights project feature, then set `NEXT_PUBLIC_SPEED_INSIGHTS_ENABLED=1`, to measure field P75 LCP/INP/CLS. Synthetic TBT is only an INP proxy.
2. Run the Android physical-device profiler against a signed, non-debuggable distribution-equivalent APK. A locally debug-keystore-signed release build is suitable for build validation, not store-signing validation.
3. Capture iOS launch and memory evidence on a physical release device and create a signed App Store archive when distribution credentials are available.
4. Confirm Expo Observe startup samples after the new mobile binary reaches real users.
5. Monitor production backend health, errors, cache behavior, and provider/settlement alerts for at least one scheduler interval after deployment.

## Rating interpretation

A 10/10 rating would imply proven performance under representative production field traffic, physical-device release traces on both platforms, verified store signing, and no remaining operational uncertainty. Those claims cannot be established from source code, CI, or simulators alone. At 9.6/10, the application has strong architecture, bounded failure modes, automated regression budgets, an exact production deployment, and clean release evidence while preserving a small, explicit set of real-world validation gates.
