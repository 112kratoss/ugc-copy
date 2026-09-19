# Creations reliability audit and implementation plan

Updated: 2026-09-19. Status: implemented — C1–C9 shipped in #171 (`2055c5e`) and the review's R1–R4 in #173 (`35825c7`); see [creations-release-review-2026-09-16.md](creations-release-review-2026-09-16.md) and [creations-followup-fix-2026-09-16.md](creations-followup-fix-2026-09-16.md). The sections below are the 2026-09-16 audit record and plan as written.

## Decision

Fix the reproduced identity bug first. Restore the existing image optimization in the same small release if its contract checks pass. Then repair cache freshness, request recovery and feed continuity. Treat the intermittent process-wide blank-media incident as unresolved until an instrumented native reproduction identifies its trigger.

A restart is recovery evidence, not root-cause evidence. Increasing cache sizes, adding retries everywhere, or upgrading Expo without reproduction would not establish a fix.

Scope: Android Profile → Creations grid → management card feed → image/video viewer, plus shared media loaders and the owner-generation API that serve those screens. Posts/Saved, iOS, and web are regression surfaces where the shared code changes. This is not a new whole-product security or generation-provider audit. Cross-platform delivery work remains indexed in [the media delivery plan](../plans/media-delivery-plan.md).

## Provenance and evidence

- Reviewed checkout: `c9bc1542f82b2d423675570c75231d627bf326c9`.
- Live `/api/app-version`, checked twice during the audit: `3697696d23673485eaf9a6b38403b3db679937f4`. The relevant Creations, source-adapter, media-loader and owner-generation service files have no diff between these SHAs. Other local work was preserved.
- Physical Samsung S24 Ultra, Android 16, package `com.magicbooklet.mobile`, version **0.1.4 (71)**. Settings on September 16 reports running update **0558882d**. This is an update-ID prefix, not a Git SHA or full runtime fingerprint.
- September 15 observation: widespread blurred tiles and a blank full-size image; force-stop/relaunch restored thumbnails, two image opens and video playback. A pending OTA had been logged before the restart. The running update before that restart was not established, so process reset and potential update activation are confounded. Original captures were in `/tmp` and are no longer present after the environment restart; the earlier conversation retains their observations.
- September 16: tapped the second-row center tile explicitly labelled “File no longer available”; the feed opened the first unrelated creation. [Before](creations-2026-09-16-evidence/unavailable-tile.png), [after](creations-2026-09-16-evidence/wrong-post.png), and XML snapshots are saved locally.
- Six subsequent grid → feed → viewer → back cycles across two images and a video all matched the selected title in the feed. Two included background/resume. Final image screenshots show loaded media; the video returns with a visible frame and pause control. This short warm-cache check did not reproduce the global blank state and is not an endurance certification.
- Existing focused checks: **69 tests passed in 7 suites**: immersive source data, profile card model, profile paging, media preview, URL expiry, showcase media and viewer position.
- [Five diagnostic counterexamples](creations-2026-09-16-evidence/diagnostics.test.ts) assert desired behavior; **all five fail** on the reviewed code. [Results](creations-2026-09-16-evidence/diagnostics-results.txt). These are audit fixtures outside the normal CI test glob, not tests that bless broken behavior. Promote them into regression tests with the fixes.

### Production read-only findings

For the affected account, at audit time:

| Check | Result | Meaning |
| --- | --- | --- |
| Generation rows / succeeded / succeeded and unarchived | 61 / 44 / 44 | Counts are server records, not the first grid page |
| Unavailable-source rows | 1 | The problematic tile is a real terminal state |
| Remaining successes with ready previews | 43/43 | No pending-preview backlog in this account |
| Referenced preview Storage objects present | 43/43 | Metadata existence verified; this pass did not decode every file |
| Image-category successes with available source | 30 | There are also 7 video-category and 6 legacy null-category successes |
| Image display renditions present | 23/30 | All 23 referenced display objects exist; 7 image rows lack this rendition |
| Video-category rows lacking a ready playback rendition | 0 | The six null-category rows need separate classification before claiming whole-library video coverage |

Storage edge logs for **2026-09-15 17:20–17:50 UTC (22:50–23:20 IST)** contained 41 image requests with this phone model's Dalvik user agent, all HTTP 200, and two Media3 requests, also 200. Image requests by UTC minute: 17:22 → 29; 17:23 → 6; 17:27 → 4; 17:43 → 2. No matching Storage image requests appeared during the observed 23:11–23:12 blank viewer interval.

This does not rule out an error at Vercel's `/api/media`, a request that never reached Storage, native disk-cache behavior, or missing/incomplete edge observations. The user agent identifies a device model, not cryptographically this installation. No matching Vercel request trace was obtained. There is no evidence here for mass deletion, expired signatures, a Storage outage, or an out-of-memory crash as the incident's cause.

Memory snapshots around six warm cycles: total proportional resident memory (PSS) rose from 658,611 to 704,888 KiB, about 643 to 688 MiB. The process was already warm and had prior navigation history. Caches, decoded images, GPU allocations and delayed cleanup can explain growth; two samples do **not** prove a leak. Measure a steady-state plateau after cleanup before setting a device-specific memory gate.

## Findings in implementation order

### C1 — P1, confirmed on phone and diagnostic: unavailable creation opens a different post

**Cause:** [generationToProfileMediaCard](../../ugc-mobile/lib/profile-view-model.ts#L194) deliberately retains successful `source_unavailable_at` rows in the grid. The API deliberately strips their output URLs. [ProfileMediaFeedScreen](../../ugc-mobile/components/profile-media-feed.tsx#L118) calls `buildViewerItems` without `initialId`; [filterViewerGenerationItems](../../ugc-mobile/lib/immersive-preview-source-data.ts#L104) removes rows without media. [getImmersiveInitialIndex](../../ugc-mobile/lib/immersive-preview-view-model.ts#L286) returns index zero when the requested ID is absent. The unavailable dress-change item therefore opens the first unrelated creation. This is one proven cause of the user's wrong-post report; it does not establish that every mismatched tap has this cause.

**Fix:** preserve the selected entity and an explicit availability state through grid, feed and viewer. Pass the selected ID, but do not stop at that one-line change: the generation adapter must carry the unavailable state to an appropriate status card/page. Missing/deleted/unauthorized selected entities must show their own not-found state, never substitute another item. Bind actions to the displayed entity ID. Preserve deliberate notification links to failed/in-progress runs.

**Acceptance:** same physical tap lands on that creation's unavailable state; no media request is attempted for its missing source. Also cover deletion between tap and fetch, failed-run deep links, all-unavailable pages, and a missing selected ID among otherwise healthy results.

### C2 — P2, diagnostic confirmed: optimized image is dropped before the viewer

**Cause:** the owner API supplies `media.displayUrl`, but [getGenerationMediaItemsList](../../ugc-mobile/lib/immersive-preview-view-model.ts#L394) places the descriptor under `preview` without copying `displayUrl` onto the generated `ShowcaseMediaItem`. [getShowcaseViewerImageUrl](../../ugc-mobile/lib/showcase-media.ts#L47) reads only top-level `displayUrl`, so it returns the original. The helper's existing unit test passes when handed a manually constructed item; the end-to-end adapter counterexample fails. The common descriptor type also does not express this server extension.

**Fix:** type and carry the display rendition through the owner API contract, URL normalization and generation adapter, only for the output to which it belongs. Keep distinct preview/display/original cache identities. Preserve original-quality download. Do not attach one output's derivative to every item in a multi-output run. Backfill the seven eligible missing display renditions separately, using bounded existing tooling after an integrity preview.

**Acceptance:** actual generation payload → viewer source selects the display object; bounded device network capture confirms original bytes are not fetched for a routine open when a display exists. Test relative and absolute URLs, null/absent display fallback, expired signatures, multi-output identity, and display failure recovery. Target under 400 KB per ordinary image open for eligible fixtures; measure actual bytes, not filename or database-column presence.

### C3 — P2, diagnostic confirmed: grid and feed use different membership

**Cause:** the grid requests `includeArchived=false` and requires a succeeded, unarchived, renderable/unavailable item. The shared source loader requests `listGenerations(true, { limit: 48 })`—the actual argument means **includeArchived**, although its local interface misleadingly names it `includeCompleted`. The feed filter checks media existence, not the grid's status/archive policy. Archived records can enter after hydration/refetch even though they were absent in the grid.

**Fix:** define one creation-library membership policy and explicit archive scope. Keep normal library membership separate from intentional status/deep-link exceptions. Correct the interface parameter name. A feed opened from a grid should retain that grid's order and scope.

**Acceptance:** grid/feed IDs and ordering agree across refresh, status changes, archival and multiple pages; a directly requested archived/status item can still use its deliberate dedicated route.

### C4 — P2, diagnostic confirmed: copying cached data erases its age

**Cause:** [source cache hydration](../../ugc-mobile/lib/immersive-preview-source-data.ts#L298) merges profile, home and general generation caches by fixed precedence, taking the first duplicate irrespective of freshness. The new query's `initialData` carries no original `dataUpdatedAt`, so a one-hour-old snapshot becomes “fresh” for 45 seconds. Each `initialId` creates another collection snapshot. The card feed has no explicit refresh on return; the immersive viewer does refetch on focus, so it partially mitigates freshness but also replaces their shared snapshot.

**Fix:** share account-scoped entity data with explicit freshness/version metadata and keep navigation-session IDs/order separate. As an incremental fix, preserve hydration age, prefer the newest version per entity, deduplicate in-flight reads and revalidate on meaningful focus/reconnect events. Refresh the active failed media's source explicitly. Preserve server authorization and never use stale data to enable a privileged action.

**Acceptance:** old cache is immediately stale; refreshed entity reaches grid/feed/viewer consistently without resetting position; fresh cache is not unnecessarily fetched. Test one-hour foreground, background beyond token/URL expiry, account switch and concurrent opens. No credentials in cache keys or diagnostics.

### C5 — P2, diagnostic confirmed: unrelated post lookup blocks a creation

**Cause:** [loadImmersiveSourceData](../../ugc-mobile/lib/immersive-preview-source-data.ts#L131) couples generations and owner-post enrichment with `Promise.all`. A rejected post lookup discards the successful generation result. A slow post lookup delays even the selected older-creation lookup. With cached cards, [the error branch](../../ugc-mobile/components/profile-media-feed.tsx#L304) is hidden because it only renders when there are no cards.

**Fix:** load the selected creation/required media independently; enrich linked-post information separately. Preserve authoritative linked visibility where available, and disable actions needing missing metadata instead of guessing. Display a nonblocking, retryable stale/enrichment warning when relevant.

**Acceptance:** post-list 500/timeout does not hide a playable creation; generation permission failures remain failures. Retry recovers enrichment without moving the reader or repeating successful downloads.

### C6 — P1 recovery gap, source confirmed; incident trigger unresolved: no deadline for an image that never completes

[StableMediaImageSession](../../ugc-mobile/components/media-preview.tsx#L93) only starts retry/recovery after `onError`. It has no load/display deadline and does not record load-start/progress/display lifecycle events. A request or native view that produces neither success nor error can show a thumbhash indefinitely, or a blank image where there is no placeholder. API fetch timeouts do not cover Expo Image's separate native loader. The full-screen video already has a load deadline; do not duplicate or remove that safeguard.

**Fix:** add a visibility-aware image attempt state machine: idle → loading → displayed, error or stalled. On a deadline, offer accessible retry; renew authorization/source when appropriate, then remount only the failed attempt. Bound concurrent recovery and retry count, pause deadlines while backgrounded, and reset latches on effective URL/auth/source changes. The grid's enclosing navigation press target and the feed's nested press targets must not intercept the retry action. Add lightweight, sampled lifecycle diagnostics through the existing backend rather than assuming store crash reports capture non-crashing stalls.

**Acceptance:** a fixture that never completes becomes retryable within a proposed 15-second foreground deadline; recovery works after restoring the endpoint without app restart. Test native image rendering, not only mocked callbacks. Capture the original global failure's actual trigger before marking that incident closed.

### C7 — P2 static control-flow defect: failed focus refresh can repeat without bound

[ProfileDashboard's effect](../../ugc-mobile/components/profile-dashboard.tsx#L207) refetches whenever focused, stale and not fetching. Fetch completion toggles a dependency (`isFetching`). On error the data remains stale, so the effect can start another fetch immediately after the query's own retry policy ends. All three media tabs become enabled after initial media fetch, increasing the scope of background work. The current grid also refetches every loaded infinite-query page on automatic refresh; only explicit pull-refresh truncates pages.

**Fix:** trigger revalidation from focus/reconnect/invalidation transitions, with a bounded cooldown and the query retry policy owning failures. Honor rate-limit cooldowns; stop while offline; do not clear the user’s scrolled pages merely to reduce load. Refresh the visible/first page and merge by identity without duplicate pages or data loss.

**Acceptance:** deterministic repeated 500/429/offline fixtures cannot produce an unbounded immediate refetch loop. Recovery occurs once on a qualifying event; browsing a large loaded library does not multiply routine foreground requests by every page.

### C8 — P2 structural gap: landing and feed continuity depend on timing and a fixed window

[Card-feed landing](../../ugc-mobile/components/profile-media-feed.tsx#L144) spends at most five attempts, ending at 640 ms; attempts can be consumed before useful layout. Seeing the target once permanently marks it landed, even if a later shared-query update reorders/removes items. User scrolling correctly cancels landing and must continue to do so. The source loader returns 48 rows plus a selected older row; the card feed has no `onEndReached` pagination. Refresh can replace a larger cached library with that smaller window.

**Fix:** anchor a navigation session to selected ID and originating scope/order. Use list layout/load acknowledgments and a bounded time budget with explicit failure UI, not a guessed 640-ms completion assumption. Retain the active entity through merges and add cursor-based continuation in the card feed. Do not load the whole library or reorder everything just to put the tapped item first.

**Acceptance:** select items 1, 6, 24, 25, 48, 49 and 100 in a fixture library; introduce a two-second data/layout delay and concurrent insert/delete. Selection stays correct, adjacent items remain reachable, reader-initiated scrolling wins, and there is no silent first-item fallback.

### C9 — P2 recovery gap: feed-video failure handling is weaker than full-screen video

[FeedVideoPlayerLayer](../../ugc-mobile/components/feed-video-preview.tsx#L201) subscribes to future status changes without reading an already-failed initial status. It has no deadline or explicit error/retry control. The parent hides its spinner on error but leaves the poster/empty surface. A player that never produces a first frame can remain loading. Full-screen playback has stronger recovery already.

**Fix:** reuse the existing bounded playback recovery policy where suitable. Read initial status, retain the poster until the first frame, show an accessible retry for the visible failed card, and recreate only its playback attempt. Keep the one-active-preview budget and release lifecycle. Explicitly test reduced-motion (no forced autoplay), manual pause, background return and auth renewal.

**Acceptance:** pre-subscription error and stalled-first-frame fixtures recover on Android; no blank-only state and no extra active players after navigating away. Do not claim successful continuous playback from a screenshot alone.

## Intermittent blank-state investigation: required next evidence

The native process/request/cache path is the leading investigation area because multiple images stalled, the app remained navigable, no matching Storage errors were seen, and restart restored images. It is still a hypothesis. Expired authorization, a Vercel proxy error, retained native work, or a changed OTA are alternatives that need discriminating evidence.

1. Record full OTA ID/runtime fingerprint/embedded status, API build ID, app session and navigation session before each run. Settings now helps identify the running update; version 0.1.4 alone is insufficient.
2. Record selected entity ID, visible entity ID, data revision/age, rendition kind, cache-hit class, request start, first byte, native load, native display, error code and retry outcome. Hash object identifiers where possible; redact tokens, signed URLs, prompts, emails and headers. Use a bounded local ring buffer and sampled failure reports.
3. On the next global stall, **capture before restarting**: ADB screenshot/UI state, app-only logs, memory and native thread/request-queue state from an instrumented build. Correlate media proxy and Storage request IDs. Native thread inspection may require a matching diagnostic binary; a release build does not expose all internals.
4. Exercise a deterministic fixture server: success, slow headers/body, never-completing body, 401 then renewal, 403/404, 429 with retry delay, 503 then success, corrupt bytes, valid thumbhash plus stalled original, and an early player error. Use non-user assets and the same Android renderer/native dependency versions. Keep fixture traffic out of real production records.
5. Run 100 opens/returns and long background/expiry checks on the physical phone, including a 30-minute session and beyond-one-hour URL/session boundary. Log memory after warmup and idle cleanup, mounted players and outstanding loads; determine whether counts plateau. A debug pass must be followed by a production-like build check.

Do not change R8 configuration, upgrade native dependencies or clear all caches as a supposed fix without a reproducible failing case and a successful same-case verification.

## Delivery plan and gates

| Phase | Work package | Dependencies and completion gate |
| --- | --- | --- |
| 1: correctness hotfix | C1; add entity availability and explicit missing-target behavior. Restore C2 display contract without a broad renderer rewrite. | Promote C1/C2 diagnostics to regression tests, both contract consumers pass, verify the unavailable tile and routine image source on the same physical phone. |
| 2: recovery and observability | C6/C9; capture current blank-state evidence; fix the native trigger once established. | Deterministic stall/error/renewal fixture passes with visible recovery, no restart, one active preview and bounded retries. Logs identify source vs decode vs display failure. |
| 3: collection/cache behavior | C3/C4/C5/C7/C8; canonical entities plus scoped navigation order, independent enrichment, incremental paging and event-driven refresh. | Remaining three diagnostics become passing regressions; 100-item pagination/reorder suite and 500/429/offline request-budget tests pass; exact ID verified on device. |
| 4: measured optimization | Repair eligible missing display files, tune measured prefetch/decode/recycle budgets, profile player release and cache plateau. | Original downloads absent from routine eligible opens; preview/display decode sizes and actual transfer logged; before/after p50/p95 first-display and first-frame times, bytes/open and settled memory compared on fixed fixtures. |
| 5: production verification | Quality gates, exact-build delivery, staged Android OTA for JS-only changes; native changes require a new binary. | Use repository `publish-ota.mjs` and target verification for compatible builds. Confirm the running update on the phone, repeat acceptance, then expand rollout after meaningful usage. Keep the known-good update and stop/rollback criteria. |

Suggested initial performance targets (proposals, not measured achievements): warm-cache visible image p95 under 300 ms; cold display image p95 under 2 s on a declared 10-Mbps/100-ms-RTT profile; visible failed/stalled media recoverable by 15 s foreground time; zero wrong-identity opens; zero original fetches when the display rendition is available; one active feed video. Set the memory cap from a repeatable baseline on the target device, and gate on a plateau rather than a single sample.

Release acceptance must cover image/video/multi-output/text, missing preview, unavailable source, completed/failed/in-progress deep links, old records, page boundaries, offline/reconnect, auth expiry, manual retry, back navigation, reduced motion and account isolation. Shared-loader changes require iOS and Posts/Saved regression checks. Backend contract changes require both mobile and web tests. Follow the existing Quality and production-release workflows; OTA delivery remains separate from merging web code.

Rollback/hold on any wrong-ID open, loss of private-media authorization, repeated unbounded requests, crash/ANR regression or worsening stall rate. With low production traffic, passing synthetic native runs is required; an empty telemetry window is not a successful rollout measurement.

## What is already implemented and should be preserved

The current code already has private URL expiry-to-proxy handling, a foreground focus bridge, bounded image retries *after errors*, full-screen video deadline/retry, preview/display/source cache namespaces, owner-scoped signature reuse, generation preview/display writers and cursor-paged profile grids. Older media audits predate some of these changes. This plan repairs broken connections and recovery gaps rather than reimplementing those systems.

The [Expo Image documentation](https://docs.expo.dev/versions/v55.0.0/sdk/image/) describes the separate native cache and load/display callbacks used in the proposed diagnostics. Existing package source was inspected for the installed Glide loader. Historical upstream issue reports were not treated as proof that this app has a particular Expo bug.
