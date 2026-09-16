# Creations selected-card landing fix — 2026-09-16

## Production reproduction

Android production update `c894d755` (source `3971552fccaa7553f90158ee48b6ff5eaf275957`) still had one separate Creations defect after the earlier reliability fixes.

Opening the marked Messi tile passed the correct generation ID into `/profile-media-feed`, and that item existed in the loaded cards. The feed nevertheless stayed on unrelated cards and displayed “Couldn't scroll to the creation you opened.” Tapping that retry repeated the failure.

This differs from the earlier wrong-selection defect: selection and data were correct here; the variable-height native list failed to land at the selected index.

## Cause and fix

The landing state checked its three-second budget every 250 ms, but those ticks returned the same state and therefore triggered no new scroll. If FlashList's first `scrollToIndex` ran before its changing card heights had settled, the screen waited and eventually failed without trying again.

While a landing is still seeking, each bounded tick now advances an attempt counter and causes another `scrollToIndex`. Only one native scroll runs at a time. Existing rules still stop the process immediately when the target becomes visible, the reader scrolls, the target disappears, or the three-second budget expires.

## Validation

- Reproduced the reported marked tile on the physical Samsung SM-S928B against production; unrelated cards and the retry notice were captured.
- Reproduced the same failure again by tapping the notice.
- Ran the actual fixed `ProfileMediaFeedScreen` on that phone through Expo Go with 18 cards, mixed aspect ratios, and a deliberately long prompt before target index 9.
- The selected card appeared on screen and no failure notice appeared.
- Focused landing tests: 14 passed.
- Full mobile suite: 228 files / 2,233 tests passed.
- Mobile TypeScript check passed.
- `git diff --check` passed.
- Clean-start missing-ID viewer on the published update still shows the intended unavailable state, ruling out a regression in the earlier selection fix.

## Evidence

`/Users/athuls/UGC copy/archive/ugc-app-audits/creations-production-check-2026-09-16/` contains the production reproduction.

`/Users/athuls/UGC copy/archive/ugc-app-audits/creations-feed-landing-fix-2026-09-16/` contains the fixed native harness, screenshot, accessibility dump, and test logs.

## Release status

The correction is on branch `fix/creations-feed-landing`. It has not been published as an OTA.

