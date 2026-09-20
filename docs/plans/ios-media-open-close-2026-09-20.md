# iOS media opening, frame isolation, and dismissal

Status: iOS now opens and closes the reel with UIKit's own zoom transition (iOS 18+) through Expo Router; the transparent-modal candidate below is withdrawn. Simulator-verified 2026-09-20; device timing and the acceptance gates in §6 still to run.
Date: 2026-09-20. Inspected baseline: `cb6cec15` (includes #185).

## Objective and recommendation

Fix the partially visible Back control, black/wrong-media flashes during loading, and laggy dismissal across iOS media entry points. Dismissal is the first performance priority. The screenshot supplies visual context; it cannot establish timing or reproduce an intermittent flash.

Keep the existing native AVPlayer playback initially and repair the presentation lifecycle. If the measured bottleneck is the React/native-stack transition boundary, introduce a small UIKit transition host. A full native viewer remains an authorized escalation if that smaller boundary cannot meet the targets. Replacing the decoder is not the initial remedy for image transitions, clipped controls, or route teardown.

This plan takes priority for these three symptoms over the broader September 19 media plan. Looping, CDN changes, and Android optimization are separate work. Existing loop experiments remain disabled.

## Evidence and hypotheses

| Symptom | Verified in the inspected source | What still needs reproduction |
| --- | --- | --- |
| Back partly visible while opening | `MediaZoomStage` clips and transforms the entire viewer, including its controls. The flight layer also draws a noninteractive duplicate Back control through `ZoomPostChrome`. The real Back button waits for `zoom.landed && zoom.drawn`. | Whether the visible half-button is the flight copy, the actual control, a safe-area change, or overlap during handoff. |
| Black or unrelated-media flash | The shared flight image has no media-specific `recyclingKey`. `reportDisplayed` and `reportVideoDisplayed` read the current global hold/flight rather than the identity of the request that emitted the callback. Readiness also has timer fallbacks. #185 already separates picture/video branches and prevents repeated opens. | A delayed callback or retained native image may expose the wrong content; this is a concrete risk, not a confirmed root cause. Check poster, backdrop, video surface, and navigation snapshot separately. |
| Laggy close | iOS uses a pushed route. The implementation slows the closing animation to 25% while popping, then waits another 90 ms after unmount before restoring its speed. The code records earlier 30–50 ms JS unmount and 67–100 ms reattachment observations. | Measure the current installed build: input delay, measurement, navigation teardown, redraw, video transfer, and animation hitches separately. Historical timings are not measurements of this session. |

Relevant files: `ugc-mobile/components/media-zoom.tsx`, `zoom-post-chrome.tsx`, `feed-media-frame.tsx`, `media-preview.tsx`, `ugc-mobile/app/viewer.tsx`, `app/_layout.tsx`, and `lib/video-player-loans.ts`.

Local Expo source confirms native AVPlayer plus AVPlayerViewController already backs the player. A booted iPhone 17 Pro simulator and a paired/available iPhone 16e were discovered. The earlier simulator recording came from a different worktree, so it is not a matched timing baseline for `cb6cec15`; the screenshot alone does not establish the exact timing of the intermittent faults.

## Implemented: UIKit's zoom transition (2026-09-20, supersedes the candidate below)

The target the owner named is the Photos app's open and close. Photos is not open source, but since iOS 18 the transition it uses is a public UIKit API — `UIViewController.Transition.zoom` — and Expo Router 55 already binds it (`Link.AppleZoom`, `Link.AppleZoomTarget`, the native `LinkZoomTransition*` views under `expo-router/ios/LinkPreview/LinkZoomTransition.swift`). The reel now uses that binding on iOS 18+; no native code of our own was needed, and the installed dev client and the 0.1.5 store binaries already contain the native side (both built with expo-router 55.0.18), so the change is OTA-eligible.

- `ugc-mobile/lib/apple-zoom.ts`, `lib/apple-zoom-available.ts`, `components/apple-zoom.ios.tsx`: a tapped tile's native view is registered as the zoom's source under `zoom|<surface>|<post>`; the push carries that identifier in Expo Router's internal param (pinned to Expo Router's constant by `__tests__/apple-zoom.test.ts`), Expo Router's own enabler sets the pushed screen's `preferredTransition`, and UIKit grows the reel out of the live tile, crossfading, on the render server. The close is the same transition reversed — Back, the edge swipe, a pinch, or a drag down, all interactive. The active slide marks where its media sits (`AppleZoomTarget`, an alignment rect) so the zoom aligns with the picture rather than the whole screen, and as the reader swipes the reel re-points the param at the tile of the post on screen (`useAppleZoomRetarget`).
- The viewer is a pushed **card** again on iOS (`app/_layout.tsx`), opaque, with the navigator's default animation for a zoom-pushed reel — react-native-screens hands a push or pop to UIKit's `preferredTransition` only under its default animation; `fade` and `none` are its own animators and would replace the zoom. The transparent-modal candidate turned every screen pushed above the reel into a sheet (native-stack's `getModalRouteKeys` treats every later route without an explicit `presentation` as a modal, and react-native-screens pushes routes that do set `card` *underneath* the presented modal) and lost the edge-swipe back. Both were reproduced on the simulator before the revert.
- Video: the tile still lends its playing player (`lib/video-player-loans.ts`) and the reel adopts it at mount, so the clip never restarts; a new loan *hold* keeps the tile drawing that player until the navigator reports the push over (`holdVideoLoan`, `components/feed-video-preview.tsx`), because UIKit animates the tile's live view and the feed loses focus the moment the push begins. On a pop the reel hands the player back as `beforeRemove` fires, so the tile shows the clip carrying on while the reel shrinks into it — for gesture-driven pops too, where JS learns of the pop after the fact.
- The layer's own flight (`components/media-zoom.tsx`) is Android's now (`LAYER_FLIGHT`); on an iPhone before iOS 18 a tile opens the reel under the navigator's fade. The flight's tests mock Android accordingly. The iOS-specific working-tree changes from the candidate below (the transparent modal, the live close on iOS, the Back copy removed from the flight chrome) are withdrawn; the media-identity checks on the flight's display callbacks, the recycling keys and the loading shell's preview are kept.
- Verified on the iPhone 17 Pro simulator (iOS 26.4, dev client on this tree, frames captured at ~6 fps with `xcrun simctl io booted screenshot` in a loop): Home video card and Explore grid tile → the reel opens by zoom with the whole post scaling out of the tile (caught ~300 ms in, ~90% size), video live throughout; Back shrinks the live video back into the tile with no black or poster frame, and the tile's clip carries on; the edge swipe drives the same shrink interactively (five frames following the finger over the live feed); the creator profile pushed from the reel is a card with a header back chevron again; vertical swipes page the reel normally (twice, including a fast full-height flick); Back from the second post shrinks into *that* post's tile (retarget). Unit: 2,431 mobile tests and the typecheck pass.
- Follow-up fix (2026-09-20, afternoon), from the owner's report that some opens — video especially — looked as if the reel scrolled into place, and that a frame of another post showed on the session's first open: bursts of a non-first post showed the first mid-zoom frame with the right post displaced ~160 pt upward and black below, while first-index opens were fine. The list only reached the tapped post after mounting (`VirtualizedList` scrolls to `initialScrollIndex` once its content is laid out, and the frame before that showed whatever sat at offset 0) — invisible under the old covering picture, visible under a zoom that shows the reel live. `app/viewer.tsx` now hands the list a `contentOffset` for the tapped post, latched on the render the list first mounts with (VirtualizedList then skips its late scroll), and the loading shell draws the lent player itself so a cold video open never passes through the poster. Re-captured: a cold, non-first video open shows the tapped post in place at ~92% one frame in, with no jump and no other post.
- One unexplained event: once, an upward swipe in a reel opened from Explore left the Explore grid showing with the reel gone, and the next tap on the same tile did not open it; the same sequence was repeated twice afterwards and paged normally, and the device log holds no JS exception. Watch for it on a device.
- Not yet done: physical-device frame timing, the alternating-media and cold-network cases, and the §6 gates.
- Known limits: a close whose target tile is unmounted (scrolled far off) shrinks to the middle of the screen (UIKit's fallback) rather than fading; Reduce Motion falls back to react-native-screens' `none`, which correctly disables the zoom. react-native-screens #3768 (iOS 26 pushback corners) is cosmetic and upstream.

## Implemented iOS candidate (2026-09-20)

- A diagnostic opaque UIKit push/pop removed the slow close but produced a first-open black shell and lost the tile-to-viewer motion. The user reported both regressions, so that approach was removed.
- iOS again uses the continuous tile flight. The viewer is now a transparent modal, keeping the origin attached while the live reel shrinks; the route pops after the close lands. The former 25%-speed close and 90 ms post-pop reattachment wait have been removed. Expo AVPlayer and the existing player-loan/return path remain.
- The noninteractive Back and mute copies are no longer drawn inside iOS's clipped flight. The real controls appear when the flight has filled the screen. Flight image/video display callbacks check the media they were mounted for, and the flight image and mirrored letterbox bands are recycled by media identity.
- While the viewer's first data query is loading, its shell shows the selected tile preview. It remains transparent if that preview has not decoded, with the attached origin underneath. The hand-off waits for a real first slide instead of hiding the origin on a timeout alone.
- Local checks: mobile typecheck, 245 test files / 2423 tests, and `git diff --check` pass. Simulator checks from the current workspace: Home and Explore image/video posts opened with the correct content and full Back control; closing returned to the feed; creator profile navigation above the viewer returned correctly. After a full Metro reload, first openings of an unviewed Explore image and video showed their selected media without a captured black loading frame. A recurring development-network toast appeared, but cached media and navigation remained usable. This is a Debug run, not Release timing certification.

Still required before claiming the performance targets: repeated frame-by-frame image/video alternation, cold/slow-network cases, physical-device Release recordings and Instruments traces, and tests of every entry surface and interactive back cancellation. The user will test this revised candidate on the simulator next.

## 1. Establish a reproducible iOS baseline

Record the installed app version, build, runtime, OTA identity, device/iOS version, and source commit. Use a separate Release test application for instrumented comparisons; match its content and configuration to the reported build. Retain the current build as the A/B baseline.

Map and exercise each entry path: Home, Explore, own profile/library, creator profiles, profile media feed, direct post links, generated output, and composer/reference lightboxes. Confirm which use the shared immersive viewer and which use `MediaLightbox` or a separate preview; do not assume all share the zoom code.

Use two visibly distinct images and two visibly distinct videos to make cross-item frames identifiable. Cover cold/warm caches, slow/offline loads, failed loads, immediate Back, repeated taps, A → close → B, swipe to B → close, carousel changes, and reopening while a previous transition is completing.

Capture frame recordings and Instruments Animation Hitches/Time Profiler traces. Correlate input, source measurement, transition start, viewer mount/unmount, destination attachment, first frame for the correct item, and completion. Use transition/media identifiers in diagnostics without recording private URLs. Separate first decoded frame, first displayed frame, and playback-state events.

Deliverable: a short evidence table for each symptom with an exact build and reproducible sequence. Per AGENTS.md, native/rendering fixes require simulator/device reproduction; unit tests alone cannot certify them. If a symptom cannot be reproduced, record what was ruled out and the missing evidence rather than implementing a speculative fix.

## 2. Remove dismissal's dependency on tearing down the viewer

First compare the existing zoom against a simple native transition as a diagnostic control. This distinguishes expensive media playback from expensive custom presentation.

Target lifecycle: input → immediate visible response → animate with both necessary surfaces available → complete/cancel transition → release obsolete views and ownership. Destination preparation must not consume the first visible animation frames. Closing must not wait for a network operation, image decode, player creation, or player release.

Prototype keeping the source/destination available through dismissal and deferring expensive viewer cleanup until the transition completes. Use a retained current-media frame where live video transfer is unavailable; never substitute an unrelated image or a video's initial poster for the frame being watched. Bound retained resources to the transition lifetime. If no valid tile exists, use a smooth fade without waiting for measurement.

If native-stack snapshot/reattachment still blocks the animation, implement a small UIKit transition coordinator/host that owns the transition container and retains the outgoing media surface until completion. Integrate with navigation through a supported boundary; do not replace react-native-screens delegates blindly. Resolve Expo player access and ownership explicitly rather than assuming its internal Swift player can be borrowed by another module.

With an iOS `transparentModal`, validate comments, details, creator navigation, deep links, stacked viewers, interactive Back cancellation, and navigation state restoration. Creator navigation above the viewer passed a simulator spot check; the other cases remain acceptance work.

Retire the creep/reattachment timing workaround only once the replacement passes the A/B checks. Preserve bounded recovery for missing geometry or interrupted navigation, but keep recovery timers out of normal readiness decisions.

## 3. Make every displayed frame belong to the current media

Model opening/open/closing/cancelled/closed explicitly. Give every transition and source generation an immutable identity, including route instance, post, carousel item, and rendition/version. Bind image-display, first-video-frame, measurement, and delayed-preparation callbacks to that identity. Ignore stale events and invalidate pending work on close, source change, and cancellation.

Reset/recycle native image and video presentation when their media identity changes, including transition images and blurred backdrops. Keep the correct preview visible until that same item's image or video frame is displayed. A timeout may reveal an intentional loading/error surface; it must not claim that the desired media has rendered. Retain immediate dismissal during loading and failures.

Keep a single explicit owner for each player across tile → transition → viewer → return. Verify rapid cancellation and delayed release cannot resume the wrong player, emit double audio, or release a player adopted by the next owner. Reuse existing loan machinery where possible; replace ambiguous ownership instead of layering another registry on top.

## 4. Give Back stable geometry and availability

Place the interactive top controls in a screen-fixed safe-area layer outside the media crop/scale container. Keep Back's full 48-point hit region available during loading and route entry, including the interval before the viewer mounts if the flight still owns the screen. Early Back cancels the open exactly once.

Remove or coordinate the decorative flight copy so it cannot appear half-clipped or overlap the real Back control. Preserve the existing top shade, mute behavior, details-page navigation, VoiceOver labels/focus, and Reduce Motion behavior. Check safe-area geometry on Dynamic Island and non-Dynamic Island layouts.

## 5. Native escalation decision

Adopt the smallest implementation that passes the same device tests:

1. Correct frame identity, controls, and transition lifecycle while retaining Expo playback.
2. Native UIKit transition host if teardown/reattachment remains on the visible path.
3. Native media view/pager if traced React view mounting or player-view transfer still exceeds the budgets after step 2. Keep product actions and data in React Native through a narrow interface.

A custom decoder/sample-buffer pipeline needs separate evidence that AVPlayer itself causes the remaining defect. It adds audio synchronization, seeking, buffering, interruption, HDR, and resource-lifecycle responsibilities. The earlier AVPlayerLooper experiment failed its acceptance gate and is not a shortcut for this work.

## 6. Acceptance and delivery

Targets below are proposed gates, not achieved results:

- Back is fully visible whenever shown, consistently positioned, and responsive during loading and cancellation.
- Zero unrelated-media frames or unintended blank flashes in captured reproduction runs; missing media uses an intentional placeholder/error state.
- Warm close input-to-first-visible-response p95 ≤50 ms; complete return to an interactive origin p95 ≤350 ms. Report cold/error cases separately and keep them independent of loading completion.
- At least 99% on-time transition frames across 30 open/close cycles per primary surface on a physical device. Report per-surface worst pauses as well as aggregate percentages; playback cadence is distinct from animation frame rate.
- 100 alternating-media cycles with bounded live players/views, no increasing retained-memory trend after warmup, no double audio, no frozen navigation, and no blank origin tiles.
- Test physical 60 Hz and 120 Hz separately where hardware is available. The current iPhone 16e covers 60 Hz; the Pro simulator cannot certify 120 Hz performance. Include Reduce Motion, background/foreground, low-power, slow network, missing return tiles, and interactive Back cancellation.

Add focused failing logic tests for reproduced callback/ownership races, plus native UI scenarios asserting both the viewer and the returned origin. Run mobile typecheck and relevant suites after each change, then the full mobile suite for the final candidate. Compare Release builds with screen recordings and Instruments; passing unit tests or an XCUITest that merely finds Back is insufficient evidence of smoothness.

Deliver fixes with before/after evidence, exact tested build identity, and any unverified device conditions. Keep a rollback path during the transition migration. Native changes require a new iOS binary and runtime verification; JS-only changes must follow the existing OTA-target checks. Production publication is a later release step, not part of creating this plan.

## Sources and interpretation

- [Expo SDK 55 video documentation](https://docs.expo.dev/versions/v55.0.0/sdk/video/): first-frame rendering is the appropriate signal for removing a loading cover; it can fire again on track changes, so identity/idempotence matter.
- [Apple transition container](https://developer.apple.com/documentation/uikit/uiviewcontrollercontexttransitioning/containerview) and [custom transition lifecycle](https://developer.apple.com/library/archive/featuredarticles/ViewControllerPGforiPhoneOS/CustomizingtheTransitionAnimations.html): UIKit coordinates participating views and explicit transition completion. The proposed host is our architecture, not a claim about Instagram.
- [Meta: Instagram iOS Dolby Vision](https://engineering.fb.com/2025/11/17/ios/enhancing-hdr-on-instagram-for-ios-with-dolby-vision/): documents a lower-level pipeline and AVSampleBufferDisplayLayer for the discussed HDR path. It does not establish Instagram's exact open/close implementation or prove that replacing our AVPlayer would solve these symptoms.
- Existing context: [September 19 implementation evidence](../audits/native-media-implementation-2026-09-19.md) and [Instagram research](../research/instagram-media-architecture-research-2026-09-19.md). Historical functional close results do not certify current frame pacing.
