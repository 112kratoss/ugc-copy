# Creations selected-card landing fix — 2026-09-16

## Production reproduction

Android production update `c894d755` (source `3971552fccaa7553f90158ee48b6ff5eaf275957`) still had one separate Creations defect after the earlier reliability fixes.

Opening the marked Messi tile passed the correct generation ID into `/profile-media-feed`, and that item existed in the loaded cards. The feed nevertheless stayed on unrelated cards and displayed “Couldn't scroll to the creation you opened.” Tapping that retry repeated the failure.

This differs from the earlier wrong-selection defect: selection and data were correct here; the variable-height native list failed to land at the selected index.

## Cause and fix

The landing state checked its three-second budget every 250 ms, but those ticks returned the same state and therefore triggered no new scroll. If FlashList's first `scrollToIndex` ran before its changing card heights had settled, the screen waited and eventually failed without trying again.

While a landing is still seeking, each bounded tick now advances an attempt counter and causes another `scrollToIndex`. Only one native scroll runs at a time. Existing rules still stop the process when the verified target landing completes, the reader scrolls, the target disappears, or the three-second budget expires.

The reported overlap had two separate causes:

1. `/profile-media-feed` passed `initialScrollIndex` to FlashList while rendering large, variable-height cards. On Android, FlashList could assign a following cell's absolute position before the preceding card reached its measured height. The visual result was real overlap, and the accessibility dump confirmed impossible bounds where the following card began before the selected card ended. This matches [Shopify FlashList issue #1797](https://github.com/Shopify/flash-list/issues/1797), whose reported workaround is to mount first and then call `scrollToIndex`.
2. The route used a native `fade`, which also composited the three-column grid and large-card feed for several transition frames.

The feed no longer supplies `initialScrollIndex`. It waits for FlashList's first layout, performs the bounded programmatic landing, keeps the list hidden behind an opening spinner until that native scroll finishes and the target is verified visible, and disables FlashList's automatic visible-position maintenance for this explicitly controlled feed. Merely glimpsing a non-first target during an intermediate scroll step no longer marks the landing complete. The route now uses the app's opaque `simple_push` transition, so the old grid and new feed are not alpha-blended.

## Validation

- Reproduced the reported marked tile on the physical Samsung SM-S928B against production; unrelated cards and the retry notice were captured.
- Reproduced the same failure again by tapping the notice.
- Recorded the production open transition frame by frame and confirmed the route fade composited the grid and feed.
- Reproduced actual settled card overlap in the physical-device native harness with `initialScrollIndex`; both pixels and accessibility bounds showed the selected and following cards occupying the same vertical range.
- Re-ran the same 18-card, mixed-aspect-ratio harness without `initialScrollIndex`. The selected card opens at the top, its full actions/caption remain visible, and the following card starts below it with non-overlapping accessibility bounds.
- Ran the actual fixed `ProfileMediaFeedScreen` on that phone through Expo Go with 18 cards, mixed aspect ratios, and a deliberately long prompt before target index 9.
- The selected card appeared on screen and no failure notice appeared.
- Focused landing tests: 16 passed.
- Full mobile suite: 228 files / 2,235 tests passed.
- Mobile TypeScript check passed.
- `git diff --check` passed.
- Clean-start missing-ID viewer on the published update still shows the intended unavailable state, ruling out a regression in the earlier selection fix.

## Evidence

`/Users/athuls/UGC copy/archive/ugc-app-audits/creations-production-check-2026-09-16/` contains the production reproduction.

`/Users/athuls/UGC copy/archive/ugc-app-audits/creations-feed-landing-fix-2026-09-16/` contains the fixed native harness, screenshot, accessibility dump, and test logs.

`/Users/athuls/UGC copy/archive/ugc-app-audits/creations-overlap-2026-09-16/` contains the production screen recording and extracted transition frames.

## Release status

The correction is on branch `fix/creations-feed-landing`. It has not been published as an OTA.
