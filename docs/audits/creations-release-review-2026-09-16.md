# Creations release review — 2026-09-16

## Verdict

The published release fixes the original unavailable-tile navigation reproduction and improves normal browsing, but the review found **four remaining defects**. Two were reproduced on the connected production Android app; two were reproduced with isolated regression probes against the published source. Do not mark audit C1–C9 fully closed yet.

This is a review of the shipped changes, not a new implementation or release. The original intermittent all-media-blank incident's initiating cause remains unproven.

## Exact release reviewed

- Pull request: [#171 — Fix Creations grid, card feed and viewer reliability](https://github.com/112kratoss/ugc-copy/pull/171).
- Published source and live API build: `2055c5e467b0adaba8efc6a8e1f791386800b342`.
- Worktree: `/Users/athuls/UGC copy/ugc-app/.claude/worktrees/edits-2026-09-16`.
- Branch: `mobile/creations-reliability`; commits `7c2f20a` and `f3ae88d`. Its tracked tree equals the published main tree.
- Physical device: Samsung SM-S928B, Android app **0.1.4 (71)**.
- Running Android OTA group: `3fe0e2ac-953d-4491-b221-530a2ec208c3`; Settings displays `3fe0e2ac`.
- EAS production listing identifies that group as published from the source above; Android runtime `db146ca386f52f78a12416a2077621628eb04300`.
- The production app-version endpoint returned the same source SHA.
- PR checks: Web app, E2E smoke, Mobile app and Supabase migration replay all successful.
- Review window: approximately 03:18–03:29 IST, September 16.

## Findings, in priority order

### R1 — P1: the viewer can still open the wrong creation during selected-item lookup

**Reproduced on the published phone build.**

With a warm Creations library, open a fresh viewer route for a missing ID:

`magicbooklet://viewer?source=profile-creations&initialId=00000000-0000-4000-8000-000000000001`

The viewer shows the first unrelated creation (the girl/Messi image), and remains there after the lookup settles. Opening the **card feed** with that same source and ID correctly shows “This creation isn't available.”

**Cause:** while the separate selection query is loading, the library already exposes its other items. The viewer only blocks on `selectionMissing`, not on unresolved selection; its initial-position effect selects index zero and stores it in `savedPosition`. Later, the missing-selection branch is suppressed by `!savedPosition`. A successful lookup of an older item can likewise be overridden by the saved unrelated position.

Relevant source: [viewer initial-position effect](</Users/athuls/UGC copy/ugc-app/.claude/worktrees/edits-2026-09-16/ugc-mobile/app/viewer.tsx:442>), [missing/loading branches](</Users/athuls/UGC copy/ugc-app/.claude/worktrees/edits-2026-09-16/ugc-mobile/app/viewer.tsx:865>).

**Fix:** explicitly gate initial rendering, playback and position settlement on the selected ID being resolved. Loading/error/missing states must win even when other library items exist. Only a position established after valid selection or deliberate reader navigation should bypass initial-selection handling.

**Acceptance:** delayed successful lookup of an older creation; missing ID; rejected lookup; warm library; no unrelated card, autoplay or actions before resolution.

Evidence: `missing-viewer.png`, `missing-viewer.xml`, `missing-viewer-settled.xml`, `missing-feed.xml`.

### R2 — P1: a failed initial library load leaves an endless spinner

**Reproduced on the published phone build and with a hook regression probe.**

Cold-started directly into the card feed while Wi-Fi and mobile data were temporarily disabled. The screen still displayed **“Loading media” at 20 and 35 seconds**, with no retry. Ten seconds after restoring both connections it remained on the spinner. Returning to Profile recovered browsing.

**Cause:** `selection` becomes `loading` whenever the primary query has no data, even after that query has failed. The card feed returns its loading branch before checking `library.isError`. The viewer combines the same selection state into its loading flag. Automatic revalidation also skips libraries without data, and reconnect refetch is disabled.

Relevant source: [selection state](</Users/athuls/UGC copy/ugc-app/.claude/worktrees/edits-2026-09-16/ugc-mobile/lib/use-profile-library-source.ts:145>), [card-feed branch order](</Users/athuls/UGC copy/ugc-app/.claude/worktrees/edits-2026-09-16/ugc-mobile/components/profile-media-feed.tsx:363>).

**Fix:** model primary loading, primary failure and selected-item lookup separately. Surface an actionable error after retry exhaustion; retry must target the failed primary read. Provide bounded recovery on an appropriate reconnect/focus event.

**Acceptance:** first read rejects with no cache; offline cold start; server 500; retry after recovery. Both card feed and viewer must leave the spinner and expose a working retry.

Evidence: `offline-check.txt`, `offline-cold-20s.png`, `offline-cold-35s.png`, `offline-restored-10s.png`, `review-library-probe.test.tsx`, `review-probes.txt`.

### R3 — P2: covered images can exhaust the app-wide recovery budget

**Reproduced by a component regression probe; native starvation scenario not forced.**

Mount two images that never emit success/error, let their 15-second deadlines acquire the two shared recovery slots, then cover their screen by setting `watchdog=false`. Both slots remain occupied.

**Cause:** disabling the watchdog clears its timer but does not release its recovery slot. A covered, detached image may produce no callback and remain mounted in the navigation stack. A newly visible stalled image then waits every 1.5 seconds for a slot; its attempt count never advances, so it also never reaches the terminal manual-retry state.

Relevant source: [watchdog effect and cleanup](</Users/athuls/UGC copy/ugc-app/.claude/worktrees/edits-2026-09-16/ugc-mobile/components/media-preview.tsx:179>).

**Fix:** release suspended recovery ownership when the surface stops being eligible; reacquire on resumption. Bound waiting for a slot as well as actual reload attempts, and ensure callbacks release ownership even when watchdog visibility changes.

**Acceptance:** two stalled tiles → cover screen → third visible stalled image; the visible image must retry or offer manual recovery within a finite budget. Test navigation, backgrounding and carousel changes.

Evidence: `review-image-probe.test.tsx`, `review-probes.txt` (expected zero held slots, observed two).

### R4 — P2: first-page refresh can skip posts during offset pagination

**Reproduced by a paging regression probe; no production posts deleted for testing.**

Load posts 1–48 in two pages of 24. Delete post 1 on the server, then refresh the head. The merged cache correctly contains 2–48, but retains the second page's old next offset, 48. Continuing from that offset now starts with post 50, so post 49 is omitted.

**Cause:** `mergeRefreshedFirstPage` replaces/deduplicates item arrays while retaining later-page pagination metadata. Offset-based Posts and Saved endpoints shift when earlier rows are removed. This is distinct from the generation endpoint's cursor pagination.

Relevant source: [page merge](</Users/athuls/UGC copy/ugc-app/.claude/worktrees/edits-2026-09-16/ugc-mobile/lib/profile-media-refresh.ts:140>).

**Fix:** use a stable continuation cursor for these libraries, or reconcile the retained-page boundary before continuing. Do not assume old numeric offsets still describe the merged collection; simply counting visible items is insufficient where filtering happens after database paging.

**Acceptance:** insertion/deletion/unsave before the loaded boundary, multiple cached pages, filtered rows and continued paging; no omitted or duplicated IDs.

Evidence: `review-paging-probe.test.ts`, `paging-probe.txt` (post 49 absent).

## What passed

- The original unavailable dress-change tile now opens its own unavailable card and matching viewer status page.
- Six grid → card → viewer → back cycles, covering two images and one video twice each, all matched the tapped title. Captured viewers displayed the corresponding image or video frame.
- A 90-second stationary Creations dwell showed stable tiles/order and no visible thumbnail reset in the captured states. Screenrecord emitted only four changed frames, showing the same grid with clock/brightness changes; the encoded stream duration is shorter than the wall-clock dwell because static frames were not emitted continuously.
- One short background/resume check returned to a populated Creations grid.
- **142 mobile tests across 17 focused suites passed.**
- **16 backend/contract tests across two suites passed.**
- Mobile TypeScript checking passed.
- Three added counterexample probes failed as expected and are retained with the evidence, outside the normal test directories.
- Wi-Fi and mobile data were restored to their original enabled settings; the phone was left on Creations. No production content was modified.

## Limits and follow-up

These checks establish observed rendering/navigation behavior, not cache hit rates or zero network activity. Native request waterfall/cache-hit measurement, signed-URL expiry and credential renewal, prolonged decoder/memory stress, large-library device paging, forced image stalls and native nested retry controls still need targeted validation. A displayed video frame is not a full playback-duration certification. iOS was not tested.

The release adds useful diagnostics and bounded recovery, but those additions do not prove the initiating cause of the earlier global blank-media incident. R3 must be corrected before relying on the recovery bound.

Recommended order: fix R1/R2 together with screen-level regression coverage; correct recovery ownership in R3; repair continuation semantics in R4; then repeat these device checks against the next exact OTA and complete the remaining cache/expiry/stress validation.

## Supporting evidence

Persistent local evidence folder:

`/Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/`

- [Device cycle results](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/cycles.json>)
- [Wrong viewer screenshot](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/missing-viewer.png>)
- [Cold-start network test](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/offline-check.txt>)
- [Recovery and loading probe results](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/review-probes.txt>)
- [Pagination probe result](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/paging-probe.txt>)
- [Mobile tests](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/mobile-tests.txt>)
- [Backend tests](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/web-tests.txt>)
- [Published OTA listing](</Users/athuls/UGC copy/archive/ugc-app-audits/creations-release-review-2026-09-16/updates.json>)

Probe files use relative imports matching `ugc-mobile/__tests__/`. To rerun, copy the three `review-*-probe.test.*` files there in a checkout of the reviewed source and run Vitest with `-t 'review:'`; remove the copied probes afterward. They assert desired behavior and intentionally fail on this release.

