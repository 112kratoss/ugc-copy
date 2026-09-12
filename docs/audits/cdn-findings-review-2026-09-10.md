# CDN findings review — 10 September 2026

**All four findings require follow-up, but their classifications differ.** Discovery-page no-store is intentional request-dependent rendering; the CSS change exists only on a divergent branch; private cache metadata remains inconsistent and production still creates one-year private renditions; CDN enforcement remains absent from performance monitoring. No cross-user disclosure or measured revocation failure is established.

This report updates the four findings in [the earlier audit](cdn-audit-2026-09-10.md). It is an audit and implementation plan, not a release or capacity certificate. No application code, deployment, Storage object, policy or cache configuration was changed.

## Build and checkout: correction to the earlier provenance

| Item | Verified state |
| --- | --- |
| Live build, start and end | `0e99c16dc33f020a31402a0ba2bee77eb255ea59` from `/api/app-version` |
| Checkout | `afa8d943d7f92b8ef7b6b63c9a7e86e54f832ea6`, branch `seo/audit-implementation` |
| Common ancestor | `85c137ea49267584932d3fcdcdd700113626f142` |
| Divergence | **25 production-only commits and 6 checkout-only commits** (`git rev-list --left-right --count production...HEAD`) |
| Latest protected production release | [34362069714](https://github.com/112kratoss/ugc-copy/actions/runs/34362069714), successful, production SHA above |
| Latest three performance runs | September 7, August 31 and August 24; all failed. Latest: [34100497652](https://github.com/112kratoss/ugc-copy/actions/runs/34100497652), workflow SHA `85c137e` |

The previous report's “six commits ahead” is misleading: this checkout is **not a descendant of production**. It lacks shipped media rendition, signed-URL reuse and deletion improvements. Integrating the CSS change must preserve the 25 production-only commits. Do not deploy this checkout wholesale or apply its net diff over production.

[Provenance JSON](cdn-audits/2026-09-10-review/provenance.json) records both commits' blob IDs for relevant files and the current release/performance run listings. Identical blobs establish parity for the auth boundary, proxy, API adapters, media redirect, preview URL helper, public TTL constant and monitoring files. The page content, CSS config, private preview writer, signer and generation deletion code differ; those differences are explicitly addressed below.

Pre-existing changes were preserved: `docs/scaling-audit.md`, three mobile files (`auth-provider-performance.test.tsx`, `home-side-menu.tsx`, `lib/auth.tsx`), the original CDN report/evidence and the launch-audit document. This review adds only this report and `docs/audits/cdn-audits/2026-09-10-review/`.

## Fresh bounded evidence

The [44 recorded GETs](cdn-audits/2026-09-10-review/http-probes.json) ran serially at 21:38:10–21:39:34 UTC on September 9, **03:08:10–03:09:34 IST on September 10**. An initial separate build check preceded these requests. Each recorded request had a five-second connect limit, 15-second overall limit, two-million-byte transfer ceiling, no retries, no redirect following and no cache-busting parameters. Recorded payload transfer totaled 2,047,087 bytes. Vercel requests reached `bom1`; Storage requests reached Cloudflare `MAA`.

No real authentication token was supplied. Cookies were absent except the expressly labeled synthetic-cookie cases. Response bodies were hashed and discarded; session-cookie values were not saved. Ordinary reads can warm caches and invoke existing admission/rate-limit/session logic. SQL was limited to Storage aggregate metadata and read-policy inspection; no private object was signed or downloaded.

| Ordinary anonymous surface, three samples | Status | Cache sequence | TTFB range | Decoded bytes |
| --- | --- | --- | --- | ---: |
| `/` | 200 | REVALIDATED → HIT → HIT | 166–1,686 ms | 702,058 |
| `/showcase` | 200 | MISS → MISS → MISS | 168–295 ms | 584,230–584,231 |
| `/marketplace` | 200 | MISS → MISS → MISS | 163–222 ms | 502,213–502,318 |
| `/blog` | 200 | HIT → HIT → HIT | 156–160 ms | 822,134 |
| Catalog, web/schema v3 | 200 | STALE → STALE → HIT | 151–164 ms | 53,657 |
| Recent feed, limit 12 | 200 | MISS → HIT → HIT | 165–450 ms | 25,092 |
| Marketplace resources, limit 12 | 200 | MISS → HIT → HIT | 168–353 ms | 9,154 |

These are diagnostic samples, not P95 estimates, organic hit ratios, cold-load LCP or global coverage. The earlier all-object public-media sweep was not repeated.

Additional boundary evidence:

- Invalid bearer requests to the already-warmed recent-feed and marketplace-list URLs returned **401, private/no-store**; no anonymous cached body was substituted. No `x-vercel-cache` header appeared on these proxy rejections; missing is not itself a failure.
- A harmless cookie and an invalid Supabase-shaped cookie both received the same recent-feed body hash as the anonymous HIT. This API resolves viewer identity from bearer authorization, not browser cookies; cookie-only neutrality is intentional here.
- Invalid auth-shaped cookies on both HTML pages still produced private/no-store MISS responses. Query variants (`sort=recent`, `access=free`) and `RSC: 1` requests were likewise private/no-store MISS. The RSC responses had the expected component content type. This is not a complete router-prefetch matrix.
- `/api/media` with a nonexistent path returned 401/private/no-store both without auth and with invalid bearer auth. Anonymous For You returned 200/private/no-store and set its session cookie, correctly excluding personalized responses from shared caching.
- One known public poster: two complete GETs returned 200/HIT, 25,180 bytes, `public, max-age=86400`; two 1,024-byte ranges returned 206/HIT and `Content-Range: bytes 0-1023/25180`. One known feed rendition: two ranges returned 206/HIT, `bytes 0-1023/465804`, and `max-age=86400`. This verifies these objects only.
- A CSS asset observed in the earlier audit returned 200/HIT twice with a one-year immutable policy. This proves the asset's availability and headers, **not browser reuse by the current inline-CSS HTML**.

Vercel can consume shared-cache directives before sending the browser response, so a downstream `Cache-Control: public` does not establish missing CDN TTL. [Vercel cache-control documentation](https://vercel.com/docs/caching/cache-control-headers)

## CDN-1 — Intentional dynamic pages; remaining performance opportunity (P2)

**Status:** confirmed in source and live. This is not a CDN misconfiguration or security defect. The request-dependent page tree deliberately remains private. API/data caching still protects portions of the work, but each page request requires server rendering and transfers its HTML anew. The small current sample does not demonstrate a latency-budget breach.

**Root cause and exact locations (checkout):**

- [`RouteAuthBoundary.tsx:46`](../../src/components/RouteAuthBoundary.tsx#L46): `RequestHintedOptionalAuth` calls `cookies()` at line 51 even for cookie-less requests; valid hints lead to server session/credit hydration. Both [`showcase/layout.tsx:8`](../../src/app/showcase/layout.tsx#L8) and [`marketplace/layout.tsx:8`](../../src/app/marketplace/layout.tsx#L8) wrap their children in this boundary. These files match production.
- [`showcase/(feed)/page.tsx:34`](../../src/app/showcase/%28feed%29/page.tsx#L34) explicitly calls the page query-dynamic; `generateMetadata` awaits search parameters at line 70 and the page awaits them at line 103. Its initial feed is viewer-neutral (`viewerUserId: null`, line 121), which helps data-cache safety but does not make the containing response static.
- [`marketplace/page.tsx:30`](../../src/app/marketplace/page.tsx#L30) exports `revalidate = 60`, then awaits `searchParams` at line 33. The Suspense boundary around results does not by itself create a fully cached response through the dynamic layout.
- Installed Next guides explicitly document dynamic rendering from [`cookies`](../../node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md#L69) and [`searchParams`](../../node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md#L119). Both request dependencies must be addressed; removing only the auth wrapper is insufficient.

**Recommended fix:** decide whether to invest in caching default discovery HTML. If yes, implement a genuinely viewer-neutral default shell with bounded cached public data, and load viewer/session state through an isolated authenticated boundary. Preserve query-specific rendering/metadata through a deliberate dynamic route or carefully designed client/filter boundary. The existing root/home split in [`proxy.ts:172`](../../src/proxy.ts#L172) is a reference for cookie-hinted routing followed by actual authentication; it is not a drop-in solution for filter and SEO requirements. Keep query variants dynamic if that best preserves crawlable content. Do not add blanket `public` headers to the current tree or assume `Vary: Cookie` makes session-bearing HTML safe.

**Acceptance checks:**

1. Production-build route output shows the intended static/ISR default; identical cookie-less default requests reach HIT after bounded warming. Define the page freshness/stale allowance separately from the data-cache TTL.
2. Compare default, filtered, paginated and unknown-query variants for correct results, canonical/noindex metadata and crawlable content. Test HTML, RSC, prefetch and client navigation without cross-serving representations.
3. Warm with anonymous → user A → user B → anonymous, then reverse the order. Test valid cookie sessions and bearer API requests, expired/malformed credentials, logout and account switching. No A identity, credits, saves, purchases, signed URLs or session cookies may appear in B/anonymous responses.
4. Any server-personalized HTML/API response remains private/no-store. A byte-identical public shell may be shared only when it contains no viewer data; personalized hydration stays uncached. Preserve viewer-neutral data caching with viewer state attached afterwards.
5. Measure signed-out and signed-in latency/bytes and mobile LCP on the eventual deployed build; do not call this opportunity resolved from a header-only patch.

## CDN-2 — CSS optimization exists locally; production release gap remains (P2)

**Status:** resolved as a configuration change on this branch, **unresolved in production**. Production [`next.config.ts:175`](https://github.com/112kratoss/ugc-copy/blob/0e99c16dc33f020a31402a0ba2bee77eb255ea59/next.config.ts#L175) enables `inlineCss`; checkout [`next.config.ts:171`](../../next.config.ts#L171) explains and disables it at line 193, introduced by `1864f2c`.

**Impact/evidence:** every sampled Home, Showcase and Marketplace HTML contains **125,722 bytes of literal `<style>` content**; Blog contains **318,933 bytes**. The Showcase body is about 4.9% above its 557,056-byte decoded-body budget, although these three requests are not a harness P95 result. This stylesheet content cannot be reused independently across full document loads. The installed [`inlineCss` guide](../../node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/inlineCss.md) also documents duplication into the initial RSC payload. Literal style-byte measurements do not include or quantify that escaped copy and are not compressed transfer savings.

**Root cause:** the fix has not been integrated into the production lineage and released. Inlining was an intentional first-render tradeoff; the measured large stylesheets make external reuse worth validating. No deployment failure is inferred from the unchanged live build.

**Recommended fix:** integrate the existing `inlineCss: false` change into a branch based on current production/main, preserving shipped media work and reconciling related SEO/CSS changes. Follow Quality and the protected production-release workflow in a separate implementation/release session. No second CSS fix is needed solely to change the same flag again.

**Acceptance checks:** exact integrated SHA passes required release gates; live `/api/app-version` matches it before and after measurements; the large global inline stylesheet disappears from initial HTML; external stylesheet links resolve with correct CSS MIME type and immutable caching. Verify cross-page/repeat-navigation reuse in a real browser, no unstyled flash or authenticated-route CSS regression, smaller compressed/decoded HTML, and mobile/desktop cold and warm LCP. Separate external CSS transfer from HTML when comparing totals. The live asset HITs in this audit do not satisfy browser-reuse or LCP acceptance.

## CDN-3 — Private-media policies remain inconsistent; active one-year writer discovered (P1)

**Status:** confirmed metadata/configuration inconsistency and unresolved revocation policy. Calling all affected objects “legacy” is inaccurate. End-user revocation latency, cache replay and cross-user access remain **unverified risks**, not observed exploits.

Fresh [Storage inventory](cdn-audits/2026-09-10-review/storage-inventory.json) confirms private buckets and:

| Private bucket | One-year objects | Bytes | Composition |
| --- | ---: | ---: | --- |
| `generated_images` | 49 | 1,388,386 | 49 preview-named objects |
| `generated_videos` | 29 | 14,498,827 | 14 preview-named + 15 playback-path objects |
| Total | **78** | **15,887,213** | **63 previews + 15 playback files** |

[Path-class aggregates](cdn-audits/2026-09-10-review/private-year-path-classes.json) expose no private filenames. Another 69 private generation objects have one-day metadata; the generation buckets also contain one-hour and five-minute policies. Public `showcase_media` still has 119 objects, all with one-day metadata. The public bucket's one-day decision is not evidence of an approved private-media policy.

**Root causes and exact locations:**

- **Current production creates more one-year objects:** [`generation-playback-rendition.ts:88`](https://github.com/112kratoss/ugc-copy/blob/0e99c16dc33f020a31402a0ba2bee77eb255ea59/src/lib/generation-playback-rendition.ts#L88) writes owner-scoped private video playback files with `cacheControl: '31536000'` at line 96. The deployed repair path calls this worker at [`media-preview-repair.ts:1034`](https://github.com/112kratoss/ugc-copy/blob/0e99c16dc33f020a31402a0ba2bee77eb255ea59/src/lib/media-preview-repair.ts#L1034). These files/features are absent from this checkout. A legacy-only backfill would leave recurrence enabled.
- [`generation-media-preview.ts:96`](../../src/lib/generation-media-preview.ts#L96) imports the public Showcase constant for private previews. Production also uses it for private image display renditions and previews at [lines 145 and 173](https://github.com/112kratoss/ugc-copy/blob/0e99c16dc33f020a31402a0ba2bee77eb255ea59/src/lib/generation-media-preview.ts#L145). [`showcase-media-cache.ts:27`](../../src/lib/showcase-media-cache.ts#L27) provides a public-content rationale, not a unified private policy.
- The prior normalization deliberately targets only `showcase_media`: [`20260808120000_showcase_media_cache_ttl_backfill.sql:37`](../../supabase/migrations/20260808120000_showcase_media_cache_ttl_backfill.sql#L37) and [`backfill-showcase-media-cache.ts:32`](../../scripts/backfills/backfill-showcase-media-cache.ts#L32). Its comments record that SQL metadata updates did not establish served CDN headers. Reusing that public-only script unchanged will not repair private policies.
- The application signs for **600 seconds** in [`media-read-service.ts:46`](../../src/lib/media-read-service.ts#L46). [`media-route-adapter-service.ts:118`](../../src/lib/media-route-adapter-service.ts#L118) returns a **browser-cacheable 302 for 60 seconds**. These are separate from the Storage response policy.
- Production additionally has an in-process signature cache: [`media-read-service.ts:46–101`](https://github.com/112kratoss/ugc-copy/blob/0e99c16dc33f020a31402a0ba2bee77eb255ea59/src/lib/media-read-service.ts#L46), capacity 256, reuse for up to 480 seconds. Its key includes **user ID, bucket, path and download filename**; reuse occurs before a fresh Storage signing/RLS operation at line 167. Route identity admission still precedes this call. This is a positive performance/isolation control, but permission-change behavior during reuse needs acceptance coverage. It is missing locally and must not be inadvertently removed.

**What is protected today:** the route verifies identity and signs with the caller's cookie/bearer client rather than the service-role client ([adapter:35, 91, 105](../../src/lib/media-route-adapter-service.ts#L35)). [Live Storage read policies](cdn-audits/2026-09-10-review/storage-read-policies.json) require `authenticated` and the owner's first path segment for generation buckets, plus a **restrictive** active-identity policy. The malformed/no-auth probes were rejected. These controls govern access/signing, not the lifetime of an already-issued capability or downloaded bytes. They do not replace a two-user live test.

**Revocation implications:** Supabase documents separate signed-token and response-cache lifetimes; token expiry/revocation does not purge warmed signed-URL entries. Storage deletion invalidates the object's entries, with propagation potentially taking up to a minute. Browser copies can outlive edge invalidation. Thus the 600-second signature does **not** establish a ten-minute replay cutoff, and one-year metadata alone does **not** measure actual private served headers or a guaranteed year of access. [Supabase Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn)

There are additional layers to include in the policy and test, rather than declaring Storage deletion sufficient:

- The stable `/api/media?bucket=…&path=…` redirect can remain in a browser cache across a logout/account switch for its 60-second freshness window; `private` prevents shared caching but does not partition that browser cache by logged-in account. Recommend no-store redirects when logout must stop reuse, and check client state disposal. This is a source-based risk, not a reproduced disclosure.
- Next Image permits signed remote Storage paths through [`next.config.ts:251–266`](../../next.config.ts#L251) and [`preview-images.ts:39–58`](../../src/lib/preview-images.ts#L39). Its one-day minimum TTL can create an additional optimized copy. Hashed previews bypass optimization and local `/api/media` URLs are deliberately excluded by the helper. Do not infer a working anonymous optimizer bypass: none was tested. Next documents that optimized-image TTL uses the larger of its configured minimum and upstream max-age, and there is no general image-cache invalidation mechanism. [Next Image caching](https://nextjs.org/docs/app/api-reference/components/image#minimumcachettl)
- Native [`media-preview.tsx:133–138`](../../ugc-mobile/components/media-preview.tsx#L133) uses explicit cache keys and `memory-disk`. No disk-cache clear call was found in the inspected mobile lib/components tree; actual logout/offline behavior and shipped-native differences were not tested. HTTP TTL is not a proven native eviction deadline.
- Workspace deletion is not equivalent to erasing every copy. Production [`generation-delete-service.ts:194–220`](https://github.com/112kratoss/ugc-copy/blob/0e99c16dc33f020a31402a0ba2bee77eb255ea59/src/lib/generation-delete-service.ts#L194) retains media for linked posts intentionally and includes playback cleanup on unlinked deletions. Its path removal loop at line 89 does not inspect Storage's returned error; preview/display fields are absent from this route's deletion list. Treat complete derivative erasure as unverified, and reproduce any gap with fixtures before fixing it. Account deletion has a broader verified Storage sweep ([`account-deletion-service.ts:292`](../../src/lib/account-deletion-service.ts#L292)); it is a different operation. Public moderation explicitly removes original, preview, rendition and teaser paths and checks Storage results ([`moderation-ops.ts:334–379`](../../src/lib/moderation-ops.ts#L334)).

**Recommended fix, in order:**

1. Define separate guarantees for preventing new signing, expiry of issued URLs, object deletion, browser/native cooperative cache retention, and lawful retained/purchased or linked-post copies. State which action triggers each guarantee. Previously downloaded/exported bytes cannot be recalled. Do not select a private one-day TTL merely because public content uses it.
2. Centralize the selected private original/preview/display/playback policies; update **all deployed writers**, especially the production-only one-year rendition writer. Decide whether strict revocation requires an authenticated no-store delivery path, optimizer exclusion and client-cache changes; lowering object TTL alone is not proof of strict revocation.
3. Prepare a dry-run manifest of affected private objects, preserve bytes/content types/ownership and retention obligations, then normalize through supported Storage operations in a separately authorized follow-up. Verify live full/ranged headers, not just SQL metadata. Do not log signed URLs or service credentials. Confirm the operation's actual edge behavior before bulk execution.
4. Preserve user-scoped signature reuse if compatible with the contract; otherwise add bounded authorization/invalidation semantics. Verify deletion completeness, retry/report Storage failures and cover all derivatives. Keep linked-post retention explicit rather than treating every retained object as a bug.

**Acceptance checks:** use two dedicated test owners and disposable private originals plus all derivative types. Confirm B and anonymous clients cannot obtain A's signed URL through `/api/media` before or after warming; retain owner/path/filename isolation during signature reuse. Warm the **exact same signed URL**, test before/after expiry from a fresh HTTP client, separately test a never-warmed token, revoke access while the owner identity remains active, then delete through the real product action. Record response status, served TTL, edge status and timestamps until the selected deadline; a query nonce is a different key and is not a substitute. Check all copies after deletion, including every derivative and optimizer variant. Repeat from a browser with caches enabled, after logout/account switching, and on the shipped native app online/offline. Test failed Storage deletion, retries and intentional retained-post/purchase cases. Require metadata convergence, served-header convergence and no newly created out-of-policy objects before closing this finding. No destructive canary was run in this audit.

## CDN-4 — Confirmed monitoring enforcement gap (P2; implement guardrails early)

**Status:** unchanged in checkout and production. The monitor records cache data but does not enforce the intended edge/private/media policy.

**Impact:** an origin-bound but fast response can pass; a private response may become cacheable without violating latency/status/byte budgets; public-media TTL or Range handling can regress unseen. Current live page MISSes demonstrate the uncovered condition, not a newly executed full harness failure. The latest failed performance run is historical and cannot certify this build.

**Root cause and exact locations:**

- [`config/performance-budgets.json:18`](../../config/performance-budgets.json#L18) has five signed-out targets without `expectedCacheStatuses`; its signed-in For You target at line 73 lacks a no-store assertion. Only the separate origin profile at line 95 sets `expectedCacheStatuses: ["MISS", "BYPASS"]`.
- [`performance-load-test.mjs:634–637`](../../scripts/perf/performance-load-test.mjs#L634) records `cacheControl`, `age` and **Vercel-only** cache status. [`:754`](../../scripts/perf/performance-load-test.mjs#L754) rejects any unexpected status only when a target opts in. There is no minimum-hit-ratio assertion, Storage `cf-cache-status` interpretation, Range contract or private cache-directive enforcement here.
- [`performance.yml:40–65`](../../.github/workflows/performance.yml#L40) uses the edge profile, two bounded warmups, and a signed-in bot. Warmups are already separated from measured samples ([harness:1055](../../scripts/perf/performance-load-test.mjs#L1055)). Results at line 1130 do not capture deployed `/api/app-version` before/after; workflow checkout SHA is not necessarily the live build.

**Recommended fix:** give each target an explicit role (public cached, viewer-neutral public, personalized private, or intentionally dynamic). Add post-warmup cache expectations for Home, catalog and recent feed; add marketplace-list coverage. Keep the two dynamic pages honestly classified until CDN-1 changes. Count HIT and permitted STALE separately, reject stale ages outside the declared policy and treat REVALIDATED distinctly rather than silently calling it a pure cache hit. Use a defined tolerated cold/revalidation budget or minimum-hit ratio for sustained runs; the existing all-samples status check alone may be brittle at TTL boundaries.

Add positive no-store and no-shared-cache checks for authenticated/personalized success and rejection responses, plus the two-user response-content isolation matrix. Marketplace listing is intentionally public even for an admitted user when its payload remains viewer-neutral; do not indiscriminately mark every authenticated public catalog/list response private. Add a tiny durable, non-user media canary on the actual Storage host: full 200, ranged 206, exact length/Content-Range, MIME type, served policy and warmed Cloudflare cache result. Restrict media hosts and byte/rate budgets and never forward app bearer credentials to the Storage canary. Keep destructive revocation tests as a separately controlled disposable-fixture job.

**Acceptance checks:** harness self-tests with deterministic good/bad fixtures must demonstrate failure for unexpected origin MISS, absent cache headers, personalized/public leakage, wrong TTL, ignored Range and wrong Content-Range/bytes. Show cold/warm separation and permitted stale-window handling. Run the bounded production monitor with deployed build IDs before and after; fail or invalidate certification if the build changes. Publish a passing exact-build report covering public edge, signed-in private and media delivery, plus separate browser vitals. A green old run or a self-test alone does not close CDN-4.

## Prioritized implementation sequence (follow-up only)

| Order | Work package | Priority / owner | Completion gate |
| --- | --- | --- | --- |
| 1 | Start from current production/main; reconcile the divergent SEO/CSS branch without losing shipped media fixes | Prerequisite / release owner | Reviewed integration diff and exact SHA provenance |
| 2 | Define private-media revocation/retention contract; inventory every deployed writer and cache layer | P1 / product + backend | Written deadlines, retention exceptions and disposable-fixture matrix |
| 3 | Add cache-policy monitoring assertions, durable public media canary and build provenance | P2, early guardrail / performance owner | Good/bad self-tests and bounded report with explicit coverage |
| 4 | Implement private policy, writer changes and any delivery/deletion isolation fixes; then normalize metadata/content through Storage | P1 / backend + web/mobile | Two-owner + expiry/deletion/client-cache checks; no recurrence |
| 5 | Integrate and release existing CSS optimization through protected workflow | P2, can proceed independently after step 1 / web + release | Deployed SHA, reduced HTML, CSS reuse and mobile/desktop LCP |
| 6 | Decide and implement cacheable default discovery pages | P2 / web + product | Public HIT plus HTML/RSC/query/SEO and two-user isolation acceptance |
| 7 | Run the complete bounded monitor on the final promoted build | Release evidence / performance owner | All intended coverage passes, stable start/end live SHA |

No CDN migration is supported by these observations. The work concerns application rendering, production integration, private-media policy and enforcement within the existing delivery stack.

## Validation and evidence limits

Existing focused checks passed on the **checkout**: **11 files / 53 tests**, covering API headers, feed route/cache policy, marketplace list/cache policy, private signing/redirect adapters, preview URL handling, preview generation and moderation. `node scripts/performance-load-test.mjs --self-test` passed (five signed-out edge, one signed-in edge, one origin target). These are not tests of production-only rendition/signature code or live two-user isolation. No implementation tests were added; no full build, load test, browser vitals, account login or production mutation was needed for this report-only session.

[Collector](cdn-audits/2026-09-10-review/probe.py), [HTTP evidence](cdn-audits/2026-09-10-review/http-probes.json), [inventory](cdn-audits/2026-09-10-review/storage-inventory.json), [policies](cdn-audits/2026-09-10-review/storage-read-policies.json), [private object classes](cdn-audits/2026-09-10-review/private-year-path-classes.json), [validation record](cdn-audits/2026-09-10-review/validation.json) and [provenance](cdn-audits/2026-09-10-review/provenance.json) are saved together. The collector initially stopped after 41 successful requests because its stylesheet-link search returned no match; only the two static-asset probes and ending build probe were resumed. The saved collector now handles that fallback. No failed HTTP request is hidden and no original probe was replayed during recovery.

Unverified: authorized private response headers; owner/non-owner live isolation; token expiry/revocation; Storage deletion propagation; optimized/browser/native retained copies; organic cache ratios, regional variation, origin CPU and billable savings. The report does not convert any of these into an asserted defect or compliance guarantee. Acceptance involving fixtures, implementation, normalization or deployment belongs to the follow-up session.
