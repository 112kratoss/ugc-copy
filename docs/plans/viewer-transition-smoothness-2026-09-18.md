# Viewer transition smoothness plan — 2026-09-18

Status: Android Explore/Home first pass implemented and checked in the Pixel 9a emulator and Samsung S24 Ultra. The iOS route and continuity pass is complete in the iPhone 17 Pro simulator, with a warm Explore-video continuity and frame-pacing pass on an iPhone 16e. Broader cold, interruption, and cross-surface physical coverage remains. A second pass the same evening replaced the cached-position return with handing the player itself back to its tile; see "Second pass" at the end.

## Desired experience

Tapping media in Explore, Home, a creator profile, Saved, or the owner's media feed should feel like enlarging the same piece of content. Closing should bring that content back without a pause, a change of video frame, a crop jump, or a feed reposition. Opening, closing, and immediately reversing direction must remain responsive.

Keep the existing destinations: Profile Creations/Posts first open the management feed, whose media cards open the viewer; Saved and public media tiles open the viewer directly. Include the management feed's selected-card landing in validation, without changing that product decision.

## Evidence collected

- Source reviewed at `21c9aed2b5bbf9b8f78a5f741a67b2313746c35e`.
- Physical Samsung SM-S928B (S24 Ultra), installed package `com.magicbooklet.mobile`, version 0.1.4/build 71, non-debuggable. Display reported 120 Hz. The installed OTA's source SHA has **not** been established, so the measurements below describe the installed app, not a certified build of the reviewed checkout.
- Recorded one Explore image open/close and one playing-video open/close. Verified the viewer and returned grid in screenshots. The video recording shows the closing video land in the tile and then change to an earlier picture when the feed player resumes.
- Separately collected three image and three video open/close cycles without recording. Each graphics-counter sample covers the input and about 0.9 seconds afterward, including mounting, return, and playback work. These are Android `gfxinfo` measurements, not isolated animation-frame timings or a causal trace.
- All sampled closes used Android hardware Back. Other entry points and iOS have been inspected in source, but have not been measured on physical devices in this review.
- An emulator recording was also collected, but its debug build is excluded from the physical-device baseline.

| Physical-device operation | Frames across 3 samples | Android janky frames | Per-run P95 frame duration |
| --- | ---: | ---: | --- |
| Image open | 254 | 21 / 8.3% | 12, 20, 24 ms |
| Image close and feed return | 133 | 11 / 8.3% | 13, 19, 24 ms |
| Video open | 272 | 33 / 12.1% | 15, 16, 26 ms |
| Video close and feed return | 159 | 26 / 16.4% | 18, 16, 17 ms |

Video closes individually recorded 8/53, 10/53, and 8/53 janky frames (15.1–18.9%). The samples support investigating closing first, but do not establish that every close is worse than every open. A video timeline discontinuity is also a separate perceptual defect from missed frames.

Evidence directory: `/Users/athuls/UGC copy/archive/ugc-app-audits/viewer-transition-review-2026-09-18/`. Key files: `phone-video-open-close.mp4`, `phone-video-close-frames.png`, `phone-image-open-close.mp4`, `phone-frame-summary.json`, and the twelve `phone-*-gfx.txt` files. Recording timestamps and host command timestamps are not synchronized; do not derive input latency from their difference.

## What the code establishes, and what still needs tracing

1. **Android closes animate the whole live viewer.** `components/media-zoom.tsx` sets `LIVE_CLOSE` on Android. `useMediaZoomStage` changes the clip's `left`, `top`, `width`, and `height` every frame around the mounted viewer tree. The viewer contains lists, media surfaces, and chrome. This is a concrete source of per-frame layout work; whether it dominates these missed frames needs a Perfetto trace. Reanimated recommends transforms and opacity over layout-property animation because the latter requires layout recalculation: [official performance guide](https://docs.swmansion.com/react-native-reanimated/docs/guides/performance/).

2. **Video continuity is asymmetric.** Opening lends a playing feed player to the flight and then the viewer. `components/feed-video-preview.tsx` unmounts its player when navigation focus is lost. `lib/video-player-loans.ts` can return a player only to a still-mounted lender; otherwise it releases it. There is no equivalent return adoption by the newly mounted feed player. The film's change of picture after landing is consistent with this implementation.

3. **The close lands directly into navigation and player lifecycle work.** The flight's UI callback calls JS, `landZoomFlight` notifies the viewer, `leave()` unhides tiles and pops the route, and the feed becomes focused. Player creation/release and focus-driven work therefore cluster near the visible landing. Trace their actual costs before choosing what to defer.

4. **iOS uses a different closing mechanism with fixed waits.** Its overlay starts at 25% speed while the route pops, then resumes normal speed after unmount plus a 90 ms reattachment allowance. These constants encode earlier device observations; they are not evidence of readiness on every device. The closing overlay also uses a still image after handoff, even when the viewer was playing video. This requires an iOS reproduction, not an Android-based claim of failure.

5. **Not every exit follows the same animation.** The back button and Android hardware Back call `zoom.dismiss`; the enabled native iOS back gesture follows the navigator's fade. The plan must cover gesture completion and cancellation as well as button dismissal.

6. **Overlay content is not a complete snapshot of current viewer state.** `components/zoom-post-chrome.tsx` renders page index zero and a collapsed caption. Returning after paging horizontally or expanding a caption can change the visible chrome when the overlay takes over on iOS. Preserve current presentation state in a future close snapshot.

7. **Opening already has useful protections.** The global flight layer begins before routing; cached post data seeds the viewer; neighboring slides and players mount in stages. Preserve those benefits. Opening still has timed player attachment and picture fades, so measure the interval through the final handoff, not just the 220 ms zoom.

## Implementation order

### 1. Establish a reproducible baseline and identify the expensive frames

- Associate installed binary, OTA ID/runtime, and source SHA. Use a release build of the intended implementation baseline; retain the installed-app recordings as reported-behavior evidence.
- Add development/profiling-only transition markers: input received, geometry ready, first movement, media surface ready, route push/pop, full-size landing, viewer reveal, close landing, tile visible, and feed player resumed. Include a transition ID, source surface, media type, and refresh rate; no media URLs or user content.
- Capture Android Perfetto FrameTimeline/UI/RenderThread traces and React commit timing. Correlate jank with clip layout, route commits, image decoding, native video surface changes, and player creation/release. Measure separately without screen recording; use film to inspect continuity.
- Repeat on a physical iPhone before changing the iOS path. Use Instruments animation/hitch analysis and the same scenarios.
- Exit condition: each proposed performance fix has an observed frame or lifecycle problem to address. Do not treat the code suspects above as proven causes.

### 2. Repair video return and destination readiness first

- Extend media ownership to support `feed → transition → viewer → transition → feed`, keyed by source surface, item, media page, and stream identity. A remounted matching tile must be able to adopt the returning player. Bound retained players and release them when no valid destination exists.
- Keep one authoritative visual owner through each handoff. Retain the current frame until the destination surface confirms it has drawn; use first-frame/display signals for normal completion, with timeouts only for recovery.
- Preserve playback time, paused state, and the frame shown through the landing. Return audio to feed policy without restarting the clip or briefly playing duplicate audio. Respect existing foreground and reduced-motion gates.
- Inspect the installed Expo video implementation before choosing surface transfer. Expo documents limitations around Android player/view sharing; do not assume two simultaneously mounted views can independently render one player. [SDK 55 video documentation](https://docs.expo.dev/versions/v55.0.0/sdk/video/).
- When the viewed media differs from the destination thumbnail (carousel page, changed post, different stream), define an intentional handoff after landing. Never silently fly unrelated media into the tile or rewind during movement.
- Verify decoder counts and memory over repeated open/close cycles. Preserve current bounded feed preloading.

### 3. Reduce the work required for every closing frame

- Prototype a fixed-layout presentation around the active media and its current chrome. Reuse the existing global flight layer where practical; avoid mounting another complete viewer/list tree for the transition.
- Prefer translation, scale, and opacity to changing layout dimensions every frame. Verify that clipping, corner radii, aspect-ratio changes, letterbox bands, text, and native video remain correct; a faster but distorted crop is not acceptable. If a native clipping primitive is necessary, measure that small prototype before committing to a dependency or binary change.
- Keep the destination feed's scroll position and layout stable through the return. Separate visual landing from expensive route cleanup and unrelated player preparation. Resume required destination content under the outgoing presentation, then reveal it when ready.
- For iOS, test a presentation that keeps the destination drawable throughout closing. Confirm subsequent creator, login, and nested viewer routes retain correct presentation semantics. If this requires native lifecycle support, document the binary impact before implementation. Replace the normal quarter-speed/90 ms timing path only when a measured readiness signal or preserved screen actually solves it.
- Keep one continuous motion curve. Do not compensate for blocking work by adding more waiting, slowing the animation, or shortening it until the hitch is hard to see.
- Guard every completion by transition ID; canceled or superseded flights must not reveal a stale tile, release a newer player, or pop twice. Add a bounded fallback if destination measurement never returns.

### 4. Finish opening and unify interruption behavior

- Preserve the tile image/player, crop, and current frame from press through viewer reveal. Let cached content drive immediate feedback; network refresh must not gate the transition or replace the selected item.
- Move expensive neighboring-player setup and nonessential refetch effects outside active movement and the first playback frames, based on the trace. Keep bounded preloading for the next swipe.
- Replace ordinary fixed attachment delays with destination readiness where supported. Remove redundant crossfades only when source and destination are visually identical.
- Make close during opening reverse from the current geometry without jumping to full screen. Rapid taps must not push duplicate routes. Handle backgrounding, failed loads, unavailable sources, and cancellation without leaving a hidden tile or pinned overlay.
- Bring iOS back gestures into a compatible transition lifecycle, including interactive cancellation. Preserve the details-page and sheet back behavior: Back dismisses the inner surface before leaving the viewer.
- Tune duration/easing last, after the frame and ownership problems are resolved. Use the existing 220 ms open / 200 ms close as the initial comparison, not as a claimed optimum.

### 5. Validate every content entry and return path

| Surface or condition | Required checks |
| --- | --- |
| Explore: All and filtered lanes | Image, active video, poster-only video; return to exact tile and scroll offset |
| Home: supported feed lanes | Same checks; partially obscured cards near the floating tab bar |
| Creator profile and Saved | Same checks; preserve source identity through stacked creator/viewer routes |
| Profile Creations/Posts | Grid → correct management card; card → viewer → same card; management feed → grid |
| Viewer browsing | Close after vertical swipes; current destination mounted, offscreen, recycled, deleted, or missing |
| Multiple media and details | Close after horizontal paging, caption expansion, comments, actions, and details; proper back priority |
| Input and interruption | Back button, Android hardware/gesture Back, iOS swipe/cancel, rapid open/close, repeated taps, background/foreground |
| Delivery conditions | Warm cache, cold media, slow/offline network, expired/failed media, late aspect ratio, image rendition swap |
| Accessibility | Reduce Motion, larger text, safe areas; no invisible interactive overlay after dismissal |

For offscreen or missing destinations, use a consistent short dissolve and preserve the source scroll position. Do not scroll the feed behind the animation solely to manufacture a return target.

## Acceptance targets and verification

Treat these as targets to verify on representative release devices, not a promise that arbitrary hardware or network conditions can never stall:

- Warm input-to-first-visible-movement P95 at or below 50 ms.
- At least 95% of presentation frames on time during both movement and final handoff; report actual refresh rate and missed vsyncs, not just average FPS. At 120 Hz the frame interval is about 8.3 ms; at 60 Hz it is about 16.7 ms.
- No repeatable app-induced presentation gap above 33 ms in the transition, and no visible freeze, black flash, duplicate image, video rewind, or crop jump at either handoff.
- Correct return item and unchanged underlying scroll offset on every valid-destination run; a deliberate fallback when the destination is unavailable.
- Twenty repeated warm open/close cycles for the primary image/video paths without decoder or memory accumulation. Run targeted cold and interruption cases separately.
- Inspect film of start, midpoint, landing, and the first 500 ms afterward. Good animation-frame numbers alone do not prove content continuity.
- Add focused logic regressions for player return, ownership cancellation, destination selection, and stale transition completions. Run existing zoom/player/viewer tests and mobile typecheck, followed by required mobile gates. Unit tests cannot certify native smoothness; reproduce and verify on the physical surfaces.

Deliver implementation in reviewable steps: baseline and causal trace; Android return continuity and closing cost; opening and shared lifecycle; iOS presentation/gesture correction; cross-surface verification. Ship only fixes supported by reproduction and before/after evidence.

## First implementation and verification — 2026-09-18

- On return to a playing Explore or Home tile, the viewer records the active video's playback time from its existing `timeUpdate` events. The next matching feed preview player seeks to that cached position before playing. Matching uses post and media URL, including posts with multiple video pages. Closing therefore performs no synchronous native `currentTime` read.
- A fixed-size Android transform prototype was implemented and checked in the Pixel 9a emulator, then rejected after exact-build testing on the S24 Ultra. Its non-uniform clip transform increased physical-device jank, especially on video close. The final change retains the established clip geometry and includes only the playback handoff.
- The Pixel 9a arm64 release build was checked across Explore image/video, Home video, Profile Saved video, and public creator-profile video entry and return. Content returned to the expected tile. Emulator graphics counters were host-bound and are excluded from performance conclusions.
- The iPhone 17 Pro simulator on iOS 26.4 was checked across Explore video, Home image, Profile Saved video, public creator-profile video, and the Profile Creations management feed. Each close returned to the correct source without a visible black frame, rewind, crop jump, or wrong-tile landing. An Explore video film confirms that the current frame is preserved through the iOS overlay shrink.
- The exact current JavaScript bundle was also installed on an iPhone 16e running iOS 26.6.2 as the separate `com.athuls.magicbooklet.zoom` test bundle; the production bundle was not modified. Its `main.jsbundle` SHA-256 is `cd6606f9a804edcce1a1c274b2eb9836bbd8f5b49f5e97af4da944f3d8a04515`.
- Physical-iPhone film of the Explore paper-boat video shows the playing frame shrink into the correct tile and remain continuous after landing, with no black flash, rewind, or crop jump. A short left-edge gesture cancelled cleanly and left the viewer playing. Three XCUITest variants could not complete the native edge pop on the device, matching the simulator automation limitation; completed interactive-pop behavior remains a manual gesture check rather than an observed failure.
- A 28.896-second Instruments **Animation Hitches** trace covered three additional warm Explore video open/back-button-close cycles without screenshot capture. The 60 Hz iPhone recorded nine compositor hitches across the three open/settling windows (longest 33.34 ms) and zero compositor hitches across all three close/feed-return windows. The Hangs instrument marked 34–52 ms potential main-thread interaction delays, including four inside close windows, but none produced a compositor hitch. Preserve this distinction: the sampled close path presented continuously, while the main-thread samples remain a profiling lead.
- The final APK was installed over `com.magicbooklet.mobile.dev` on the 120 Hz Samsung SM-S928B. The Play-signed `com.magicbooklet.mobile` package and its data were left untouched.
- Exact-source physical comparison used the same `.dev` package and account state. Ten clean-`HEAD` video cycles were collected around five final-build cycles to expose run-order variance. Aggregate clean-`HEAD` results were 129/973 janky frames for open (13.3%) and 49/604 for close (8.1%). The final cached-handoff build recorded 57/429 for open (13.3%) and 26/305 for close (8.5%). Within this sample, the handoff does not materially change transition frame performance. Five image cycles were similarly close: clean `HEAD` 11.6% open / 6.0% close; final handoff 12.1% open / 4.0% close.
- The original installed-app film showed a repeatable earlier-frame jump after a video landed. Simulator film of the handoff build did not show that jump. A final uninterrupted physical recording of the cached-handoff build also keeps the current video frame through the Explore landing and afterward, with no rewind, black flash, or crop jump visible in that sampled return. Screen-recorded film is visual evidence only and is excluded from the performance comparison.
- Mobile typecheck, focused playback regressions, `git diff --check`, and a lower-concurrency full suite passed: 238 files and 2,365 tests.

Remaining work: cold and interruption cases, a manual physical-iPhone completed edge pop, repeated memory/decoder checks, and the full physical cross-surface matrix above. The first pass should not be described as meeting the 95% frame target across all entry points yet; the physical iPhone sample certifies the warm Explore-video close path only.

Simulator and physical recordings, frame counters, comparison summaries, and APK checksums are retained under `/Users/athuls/UGC copy/archive/ugc-app-audits/viewer-transition-review-2026-09-18/`.

## Second pass: hand the player back — 2026-09-18 evening

### What a moving clip showed about the first pass

The first pass was checked on the paper-boat clip, which barely moves; a return that changes frame looks continuous on it. Filmed again on the S24 and the iPhone 16e with the high-motion "kungfu cats" clip:

- **S24, Home, Back.** The live close landed with the clip playing, then the tile showed its poster (the clip's first frame) for about two captured frames, then the clip again from ~0.3–0.5 s earlier than the reel had reached. The cached position was up to one `timeUpdate` (250 ms) old, the reel kept playing ~130 ms past landing before the pop, and the tile's new player showed its poster until it drew.
- **iPhone, Home, Go back.** The close shrank the poster (frame 0), not the frame on screen, then the tile jumped to the cached position: two changes of picture instead of one.
- **Unrelated to the transition:** the iPhone's Home card for that clip sat right at the 55% playback-visibility threshold and was paused before any open, so the returned tile stayed on a frame. Not changed here.

### What changed

- **The reel hands the tile its own player back** (`handBackVideoPlayer`, `claimReturnedVideoPlayer` in `lib/video-player-loans.ts`). A close into the tile that lent the player, still showing that player, gives it back; the tile's `FeedVideoPlayerLayer` carries on with it instead of creating one, with the poster kept down. A tile registers which stream it would take (`acceptVideoReturn`), so a reel only hands back to a tile that will answer; the hand-back stays pending until the tile has taken and drawn it and the reel has gone, so the tile can hold the player while its screen is still unfocused under the closing reel. An untaken player is released after `VIDEO_RETURN_TIMEOUT_MS`. The reel no longer pauses or stops a player it handed back (`isVideoPlayerHandedBack`).
- **Android (live close):** at landing the tile takes the player under the reel (one view per player, so the reel's view holds its last frame), and the reel is hidden once the tile reports its first frame, then popped. Traced: the hide set together with the pop reached the screen *with* the pop, ~50 ms late, because Reanimated 4.2 pauses its own commits while React commits (`DISABLE_COMMIT_PAUSING_MECHANISM: false`). The reel now hides first and pops from the hide's completion callback.
- **iOS (overlay close):** the layer carries the playing video itself (a second `VideoView` on the same `AVPlayer`), prepared out of sight with the standing close picture, so the close still moves on the next frame; at landing it waits for the tile's view to draw before letting go.
- **Hidden-tile race fixed:** `finishOpen` hid the source tile even when a close had already begun. A close during the reel's hand-off fade let the fade's callback hide the tile after the reel had gone; filmed on the S24 after two quick taps, the tile stayed empty until another close cleared it. It now never hides a tile once a close has begun.
- The cached-position code (`lib/feed-video-return.ts`, `updatePosition`/`getPosition`) is removed; the registry keeps `playerFor(post, stream)` for the hand-back check.

### Verification

- **S24, exact build** (`com.magicbooklet.mobile.dev`), warm Home video closes filmed at 120 Hz, largest gap between video-frame changes in the first ~250 ms after landing: before 116 / 140 / 112 ms; after 49 / 50 / 58 ms (normal 24–30 fps cadence). No poster, no rewind (contact sheets in the evidence folder).
- **S24 traces (no screen recording):** reel's last frame −9 ms, player moves to the tile's surface at 0, tile's first frame +7–10 ms, reel stops drawing +25–28 ms (Home and Explore). Before the hide-then-pop change the reel stopped drawing +77 ms after the move.
- **iPhone 16e, exact JS** (`com.athuls.magicbooklet.zoom`), Explore kungfu cats, ~10 fps bursts: the shrinking window shows the clip still playing, lands, and the tile plays on from the same moment.
- **Rapid open/close:** after the fix, 28 cycles on the S24 (image, poster-video and Home tiles, Back 0.35–0.85 s after the tap) and 6 on the iPhone left every tile visible, with no crash and no `hasBeenDisconnectedFromVideoView` error. The race was first hit on a playing Explore tile; the fix does not depend on whether the tile lent a player. Explore image close unchanged.
- Mobile typecheck; full suite 238 files / 2,380 tests; new unit tests for the hand-back lifecycle and the tile taking a player back; `__tests__/zoom-returns-the-video.test.ts` pins the timing seams.

Evidence, trace summaries, checksums and the patch: `/Users/athuls/UGC copy/archive/ugc-app-audits/viewer-transition-review-2026-09-18/handback-second-pass/`.

### Still open

- Not committed or published; the change is in the working tree on `main` at `21c9aed2`.
- iOS was measured with XCUITest bursts (~10 fps), not a 60 fps capture; the close start and landing on the iPhone want a QuickTime film before calling them frame-exact.
- A hand-back only happens for the tile that lent the player (same post, same stream, not a retry's player). A tile that was a poster, a teaser, or a post reached by swiping in the reel still starts its own player.
- Creating the tile's `VideoView` at landing inflates a `PlayerView` on the UI thread (6–17 ms traced); pre-creating it during the close is a possible next step if a frame drop shows there.

## Check-up on both phones — 2026-09-18 night

A section-by-section frame check of opens, the reel, closes and feed scrolling on the S24 and the iPhone 16e (each scenario run twice), plus the media delivery path, is in `docs/audits/media-smoothness-checkup-2026-09-18.md`. Flights are clean on both phones. What remains is at the ends: the reel's first mount (both), video view creation (Android), per-video-frame redraws in the Android reel, and a freeze at every iOS loop. It also found and fixed a server bug: the display-size image was never served, so image opens downloaded originals.
