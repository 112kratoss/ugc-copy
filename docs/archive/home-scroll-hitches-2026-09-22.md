# Home scrolling hitch investigation and fix plan

> Archived 2026-09-23. Its JavaScript layers shipped with the set-once buffer target in #195 (the per-tile activation store, the stepped and hysteretic prepared window, the fast-coast hold, the carousel pause, the tab bar subscription and the render fixes). Layer 2, the iOS light video host, stays an experiment in `ugc-mobile/experiments/ios-light-video-view/` until a store build carries it. Kept as the investigation log.

Current follow-up: [September 23 plan](home-scroll-follow-up-2026-09-23.md). The owner still reports stuttering after these experiments. Preserve the log below as history; its proposed fixes and inferred frozen-frame counts are not a completed-fix claim.

Status (2026-09-23 ~01:00): the owner's stutter is frozen frames while the list moves: 2–5 skipped refreshes, which Instruments does not count as hitches (`motion_gaps.py`). Rocking up and down churned video players on every reversal. Build 6 adds window hysteresis on top of build 5's fast-coast hold and carousel pause. Rocking comparison, build 5 → build 6: players created 7 → 2, frozen motion 411 → 235 ms, no freeze over 50 ms. Installed as "Magicbooklet Zoom". Open: per-frame render cost (7–10 ms at 10–11 offscreen passes), the clip walk (store build), and the rail gradients. Reduce Transparency made no felt difference to the owner. Not committed, not deployed.

## Implementation log

- The exported production stacks inspected before the session interruption contained React Native mounting transactions and `AVPlayerViewController` initialization during measured interaction delays. Sampling was sparse (21 main-thread samples inside the reported delay windows); this supports reducing native video-view churn, but does not attribute every hitch to playback.
- Home now routes native drag/momentum and viewability events through `lib/home-feed-playback.ts`, reusing the existing Showcase activation reducer. Passing videos no longer replace the active/prepared selection during motion. An outgoing video pauses when it is no longer qualified; its prepared anchor is retained. The resting destination is elected at native momentum end or the existing no-momentum fallback. Viewability notifications do not postpone that fallback.
- Chip changes reset the controller; focus/background interruptions clear pending motion. Player-level focus and foreground handling remains in `FeedVideoPreview`. No carousel, dock, native player implementation, or visual styling changes are included without further evidence.
- Platform choice: UIKit's `scrollViewDidEndDragging(_:willDecelerate:)` and deceleration callbacks are already exposed by React Native/FlashList as drag/momentum events. The existing cross-platform reducer and 120-ms fallback cover missing momentum callbacks; no new native module is needed. Reference: https://developer.apple.com/documentation/uikit/uiscrollviewdelegate/scrollviewdidenddragging(_:willdecelerate:).
- Six new controller regression tests cover stable preparation through flings, reverse drags, visible-winner retention, missing momentum, empty/image reports, reset, interruption and disposal. Mobile typecheck and the full suite passed: 253 files, 2,461 tests.
- The updated simulator bundle loads Home, plays video, and opens/returns from the reel. Automated simulator drag commands still register as taps, so this is functional smoke coverage, not a successful scrolling/performance validation.
- The original `/tmp/scroll-audit` files were no longer present when work resumed at 19:45 on September 22. Their measured summaries above remain in this document and the conversation; raw traces must be recaptured for further stack analysis. New build logs and test artifacts are kept outside git at `/Users/athuls/UGC copy/archive/home-scroll-audit-2026-09-22/`.
- A separately identified release test app was built and installed under `com.athuls.magicbooklet.scrolltest`, named **Magic Scroll Test**. The selected personal signing team cannot provision the production capabilities; the test-only signing configuration omits push, Apple Sign-In and associated-domain entitlements. Its copied app Info.plist removes URL registrations to avoid intercepting production links; the copy was re-signed with the existing development identity. This is for scrolling validation only and does not alter production app settings. Do not use it to validate authentication or shipping configuration.
- Release build succeeded. The bundled production client configuration was checked without printing credential values. The packaged app passes `codesign --verify --deep --strict`; its provisioning profile matches the test bundle ID, includes the connected iPhone, and expires September 29, 2026. Device installation succeeded, but launch was rejected by iOS with its generic invalid-signature/inadequate-entitlements/untrusted-profile error. Developer Mode is enabled. User inspection of the on-device launch prompt is pending; no fixed-device performance capture has been obtained.
- Next step: open Magic Scroll Test on the phone, resolve any recognized developer trust prompt, reach Home, and explicitly synchronize a timed scrolling capture. Do not publish or describe the stutter as fully fixed before that validation. The periodic rendering spikes remain a separate unverified candidate.

- 2026-09-22 evening: the owner judged the gate-until-rest candidate not optimal, because videos should start while scrolling. Re-read against the code: starting a prepared player is cheap; the costs that share its frame are the whole-list `extraData` re-render and the native `VideoView` mount/unmount (an `AVPlayerViewController` on iOS). Superseded by the revised plan below; the phase reducer and FlashList wiring stay.

- 2026-09-22 night, Layer 1 implemented (uncommitted, on top of the earlier candidate):
  - `lib/feed-video-activation.ts`: per-tile store (`activationOf`, `subscribe(id)`, `publish`, readiness). Home cards and Explore pins read it with `useSyncExternalStore`; activation left FlashList `extraData`, so an election re-renders only the tiles it concerns.
  - `FeedVideoPreview` reports `onReadyChange` (first frame drawn and not failed; withdrawn on unmount or failure), passed through `ShowcaseMediaPreview` (carousel: current page only).
  - `reduceShowcaseActivation` takes an optional `readyWhileMoving`: in motion it elects among ready candidates plus the one playing. Explore passes none and keeps electing at rest.
  - `lib/home-feed-playback.ts` rewritten: elections publish at once and keep the outgoing video prepared; the prepared window then moves one tile per `FEED_PREPARED_WINDOW_STEP_MS` (32 ms), releases before mounts. `connect()` replaces `dispose()` so Fast Refresh or a remount cannot leave a dead controller.
  - `FEED_VIDEO_VIEW_PROPS.allowsVideoFrameAnalysis = false`. AVKit: with it on, the controller "tries to find objects, text, and people when you pause media playback"; every prepared tile is paused and none takes touches.
  - Tests: store (per-id notification, hook re-renders only its tile), controller (fling across a whole feed: every video starts mid-drag, at most one native view change per commit in motion, none in an election commit, budget of three live players), reducer and tile readiness. Full mobile suite 255 files green; typecheck clean.
- Simulator verification (iPhone 17 Pro dev client, own Metro on :8082, real drags from the ReelProbe XCUITest runner; the simulator tool's `touch_path` and `swipe` never start a UIScrollView drag):
  - Next video elected 182 ms into a slow drag, finger still moving; window moves 33 ms apart (prepare, or release then prepare); reversing resumes the earlier video mid-drag.
  - No black surfaces or poster flashes across the handoff frames. Reel open/close keeps the playing player (no re-election, clip continues). Chip switch resets and re-anchors. Scroll-to-top re-elects.
- Pre-existing, not caused by this work: on a cold first visit Explore never reports playback viewability, so no tile plays until a scroll or refresh. The branch's untouched `showcase.tsx` behaves the same. Split out as its own task.
- `verify-ota-target` fails on this branch for reasons outside this work: its `ota-targets.json` predates main's record of iOS build 54 (the tree's iOS fingerprint equals build 54's), and Android moved when main added the iOS cache-ownership patch.
- Layer 2 written: `experiments/ios-light-video-view/` (patch + README), `LightVideoView` backed by `AVPlayerLayer`, first frame from `isReadyForDisplay` KVO, background pause via `VideoManager`, chosen by the React wrapper only for `nativeControls={false}` on binaries reporting `supportsLightweightViews`. Applies cleanly with `patch-package --patch-dir`; pinned by `__tests__/ios-light-video-view-experiment.test.ts`.

- Layer 2 on the simulator: a dev client built from a space-free worktree with the experiment applied (3.5 min with cached pods), JavaScript served from that worktree (it needs the primary's `.env.local` and `.env.development.local` copied in, or the dev bundle has no backend). The module reports `supportsLightweightViews` and the wrapper registers `LightVideoView`. Home tiles play through it with `cover` fit, and posters lift on the layer's `isReadyForDisplay`. Real drags hand off cleanly with no black surfaces. The reel opens and closes with the live video carried both ways, and backgrounding then returning resumes the tile.

- iPhone, 2026-09-22 21:36: after a session restart wiped the scratchpad, the worktree and builds were recreated. Release build `com.athuls.magicbooklet.zoom` ("Magicbooklet Zoom", free team, no OTA, `.env.production`, Layer 1 + Layer 2) built in 3.5 min, installed and launched; the bundle carries `NativeLightVideoViewIOS` and `allowsVideoFrameAnalysis`. The scripted A/B (`archive/home-scroll-audit-2026-09-22/device-ab/run_ab.sh` + `ab_read.py`, ReelProbe `PROBE_PART=home-slow`) failed twice before any gesture: "Timed out while enabling automation mode". Needs Settings → Developer → Enable UI Automation (toggle it, accept any passcode prompt), then rerun `./run_ab.sh A1-production com.magicbooklet.mobile 45` and `./run_ab.sh B1-zoom com.athuls.magicbooklet.zoom 45`, and read both with `python3 ab_read.py <label>`.

- 2026-09-22 ~21:45, the owner on the iPhone: the Layer 1 + 2 build "is still stuttery". Re-read of the original trace: 10 of the 15 hitches were flagged as expensive *rendering* (11–13 offscreen passes each), only 5 as expensive app updates. Layers 1 and 2 cut app-side work only.
- The Simulator's Debug → Color Off-screen Rendered overlay (needs Simulator frontmost; the background menu item is disabled) showed what renders offscreen on every scrolled frame. Each visible card's four corners (`FeedCardShell`'s `overflow: 'hidden'` with a continuous-curve radius). Each creator avatar. The Create disc (React Native draws `boxShadow` as a shadow layer with a mask, and masks render offscreen; `RCTBoxShadow.mm`). The Liquid Glass dock pill and its box-shadow band. The header carousel's slide corners while the top of Home is on screen. Two cards on screen add up to the 11–13 passes the trace reported.
- Fixed without any visible change: the card shell no longer clips (every child is inset from its corners). The Create disc's shadow moved to the layer's own shadow props, which Fabric gives a `shadowPath` over an opaque background (`RCTViewComponentView.mm`, "calculate shadow path from border"), same look. Pinned by `__tests__/feed-render-cost.test.ts` (positive control: re-adding the clip fails it). Rounding the avatar photo instead of its container did not help, because `expo-image` clips inside its own view, so it was reverted. The overlay afterwards: card corners and the disc's pass gone; dock, avatars and carousel slides remain.
- The dock is the largest remaining offscreen area and a design decision: Liquid Glass samples and refracts what scrolls under it on every frame. Reduce Transparency switches the dock to its solid surface (`useTabBarSurfaceMode`), which isolates the glass's cost on the device with no build.
- Device build 3 (22:05, `SKIP_PREBUILD=1`): the worktree's copied `.env.local` made the production bundle refuse (empty RevenueCat keys override `.env.production`), so the local env files are moved aside for Release builds and restored for the simulator Metro.

- 2026-09-22/23 night, measured on the iPhone. The automation timeout was a passcode prompt on the phone, not the setting. Scripts, traces and readers are in `archive/home-scroll-audit-2026-09-22/device-ab/`: `run_ab.sh` + `ab_compare.py` (system-wide), `run_tp.sh` + `tp_read.py` + `tp_compare.py` (Time Profiler attached to the zoom build), and `frame_costs.py`.
  - **Store app vs builds 3 and 4, scripted.** Every build drops about one frame per fling. Store app: 100–105 ms of hitches per 23.5 s of flings. Build 3: 117 ms. Build 4: 167 ms. Slow drags: 67 ms per 26 s on the store app and on build 3. Layers 1–2 and the card/disc render fixes did not move the measured hitch time. Single runs are noisy because For You is ranked per launch, so each run scrolls different posts. After `END`, XCUITest's accessibility snapshot costs a 58–101 ms commit, so the window ends at `END`. The second of two back-to-back recordings came out without the per-process `hitches` table twice; a 60 s gap avoided it once.
  - **Render server.** The owner's own trace shows about 2 ms per frame at rest and about 6.3 ms while scrolling. Flings spike to 15–19 ms. Offscreen-pass count does not predict render time: frames with one pass render as slowly as frames with ten.
  - **Main thread, from Time Profiler during flings.** Three costs:
    1. React Native's clipped-subviews walk: 28 % of main-thread CPU (0.9 s per 23.5 s). `RCTScrollViewComponentView -mountingTransactionDidMount:` calls `_remountChildren` after every mounting transaction, and `-scrollViewDidScroll:` calls it every 44 pt. It converts a rect into every descendant, even with `removeClippedSubviews` off everywhere (`UIView+ComponentViewProtocol.mm`). FlashList passes `false`, and only `enableViewCulling` skips the walk.
    2. Players created mid-fling. expo-video builds the item on the main thread (`VideoSourceLoader` → `VideoAsset.init`). AVFoundation's own item notifications then make synchronous calls to the media server (`-[AVPlayerItem _loadedTimeRanges]` → `FigXPCSendStdCopyPropertyMessage`). While blocked, the main thread shows no samples, so these hitches looked idle.
    3. expo-linear-gradient paints on the CPU (`LinearGradientLayer.display()` → `ctx.drawLinearGradient`): 18–22 ms whenever the header rail's dozen slide gradients redisplay. It was seen at test start and end next to accessibility activity, not on every turn.
  - **Build 4.** The rail turn is skipped while the rail is off screen or the feed moves (`shouldTurnHomeSlides`, controller `isMoving()`). The tab bar subscribes to the ambient colour only for the adaptive surface; glass and the solid bar never paint it.
  - **Build 5.** The prepared window holds while a fling coasts faster than `FEED_FAST_COAST_PT_PER_MS` (1 pt/ms). `fastCoastHoldMs` computes the hold from the release velocity and UIScrollView's normal deceleration, 0.998 per ms. A finger or the end of the coast ends the hold. Profiled flings, one run each:
    - Build 4: 3 hitches, 83 ms. Two lasted 33 ms: one while a player was created and an image reloaded, one blocked on a media-server call.
    - Build 5: 3 hitches, 50 ms, all single frames, none with player work.
  - **The owner, ~00:30:** build 5 still stutters, with and without Reduce Transparency, "scrolling up and down in the same window". The owner left the app on two video cards. The probe gained `testWhatIsOnScreen` (touches nothing) and `PROBE_PART=here`: rocking at the current spot, with `PROBE_ROCK` swing size, `PROBE_ROCKS` and `PROBE_SCROLL_FIRST`. `run_tp.sh` gained `ATTACH_RUNNING=1` (no relaunch).
  - **What the owner sees is frozen frames, not hitches.** During 14 s of the owner's own rocking, captured while XCUITest waited for the app to idle, the display skipped 2–5 refreshes 18 times while the list was moving (483 ms, about 38 ms per moving second). Instruments flagged none of these as hitches: a frame the app never produces is not "late". `motion_gaps.py` counts them: display gaps of 2–5 refreshes with our commits on both sides. The owner's original trace scores 126 ms per moving second. Scripted flings score about 15 on every build.
  - **Cause while rocking: player churn.** One card plays and two neighbours stay prepared. Rocking flips which card plays, and each flip moved the three-card window by one: one player released and one created on the main thread (`VideoAsset.init` with file-system calls, `LightVideoView.init`, `AVPlayerLayer dealloc`). That meant commits of 11–18 ms at each reversal. Build 5 rocking with 0.55-screen swings created 7 players.
  - **Build 6: the window has hysteresis.** It trades a near neighbour for a new one only when the reader reaches a card it was not built around (`builtFor`, the last two anchors). Players more than `KEPT_VIDEO_GAP` (2) videos away still go, the reached card always gets its player, and spare budget is still filled. Test: rocking between two drawn cards changes only play/pause, with a positive control. Same rocking script, build 5 → build 6: players created 7 → 2, hitches 10 (200 ms) → 5 (100 ms), frozen gaps 411 ms → 235 ms, and no freeze over 50 ms (build 5 had five of 67–83 ms).
  - **Left in build 6's gaps:** renders of 7–10 ms at 10–11 offscreen passes (one 16 ms), the clip walk, and one player creation on reaching a new card. `expo-observe`'s `expo-app-metrics` also keeps a display link on the main thread for the app's lifetime (`FrameRateObserver`, `MainSession` never stops it). It is small, but it is one per frame.
  - **Open.** Three items remain:
    1. The clip walk needs a store build. iOS links `React-Core-prebuilt` (`RCT_USE_PREBUILT_RNCORE` unless `ios.buildReactNativeFromSource`), so a source patch is ignored. A blanket swizzle is unsafe: react-navigation's `ResourceSavingView` turns clipping on for unfocused screens on iOS, and `FlatList` can default to it. The fix is a count of clipping views that skips the walk at zero, either in a from-source React Native or as a counted swizzle.
    2. The glass dock's share of render time. Reduce Transparency swaps in the solid bar.
    3. The rail's gradients could move to React Native's `experimental_backgroundImage` linear gradient, a `CAGradientLayer` drawn by the render server, same look.

## Revised plan (2026-09-22, evening): the cost is not `play()`

### Why the first implementation is the wrong lever

The local change gates *elections* on the native scroll phase, so nothing starts until the feed is at rest. That removes the mid-scroll hitch by removing mid-scroll playback: a slow, continuous scroll (the way the owner scrolls Home) never starts a video, and the whole handoff still lands in one commit the moment the finger lifts or momentum ends. Instagram starts a post as soon as it is mostly on screen, while the finger is still moving. That is the behavior to keep.

Starting a video that already holds a prepared player is cheap: `FeedVideoPlayerLayer` flips `playing`, widens the buffer and calls `player.play()` on an `AVPlayer` whose first frame is already on screen. What lands in the same frame is expensive, and it is what the exported stacks named ("React Native mounting transactions and `AVPlayerViewController` initialization" inside the interaction delays):

1. **A whole-list re-render.** `onPlaybackViewableItemsChanged` in `components/home-dashboard.tsx` writes activation state, `feedExtraData` changes identity, and FlashList re-renders every mounted cell (the viewport plus 900 dp of `drawDistance`, roughly eight to twelve cards). `renderCard` builds new closures on every call, so `memo(HomeFeedCardView)` never bails. All of that reconciles in the commit that starts one video.
2. **One native video view created and one destroyed.** The prepared window re-anchors on the new winner (`selectPreparedShowcaseVideoIds`): the next neighbour mounts a `FeedVideoPlayerLayer` (`createVideoPlayer` plus a `VideoView`) and the departed neighbour unmounts one. On iOS a `VideoView` is an `AVPlayerViewController`: expo-video's `VideoView.init` reads `playerViewController.view` and adds it as a subview, which loads the controller's whole view hierarchy on the main thread, and every window move calls `beginAppearanceTransition(_:animated: true)` (`node_modules/expo-video/ios/VideoView.swift`). On Android it is a `PlayerView` inflate plus the TextureView create/destroy waits the 09-18 check-up measured as `postAndWait` 15–20 ms in Home flings.
3. **A cold winner.** When the elected card was not prepared (a fling past the window, or a neighbour whose player had not been created yet), its own player and view are created in that same commit.

The iPhone 16e has a 60 Hz display, so the fourteen ~16.7 ms hitches are single dropped frames, consistent with one native view mount per video passed; the one 66.7 ms hitch fits the whole stack landing together, or a cold winner. The 09-18 check-up found iPhone Home *flings* clean because 55 % for 180 ms rarely qualifies a card mid-fling, so "main-thread work (37–63 ms) lands only once a fling has stopped". Slow scrolling qualifies cards while moving, and the same work lands mid-motion. This reading fits all the evidence but is not yet attributed frame by frame; the measurement section below closes that gap first.

### The fix, in layers

Principle: keep electing during motion, but let an election touch **one tile's `active` flag and nothing else**. Native view creation and destruction get frames of their own, and the largest single cost, the iOS view, gets cheaper at the root.

**Layer 1 — JavaScript, OTA-able (first).**

a. *Per-tile activation store instead of `extraData`.* A small external store (`lib/feed-video-activation.ts`, shared by Home and Explore) holds `{ activeIds, preparedIds }` and notifies per card id. `HomeFeedCardView` derives `videoActivation` from `useSyncExternalStore` keyed by its card id, and `showActiveVideo`, `showPreparedVideo` and `feedExtraData` go away. An election then re-renders the one or two tiles concerned, never the list. Explore (`app/(tabs)/showcase.tsx`) carries activation in `extraData` the same way and takes the same store.

b. *Tiles report readiness.* `FeedVideoPreview` tells the store when its player has drawn (`onFirstFrameRender`) and when it loses it (unmount, failure). "Prepared" becomes a fact the store can check rather than an intention.

c. *Elect during motion from ready tiles only.* The controller (`lib/home-feed-playback.ts`, rewritten on top of the existing phase reducer) elects at once, in any phase, when the qualified winner is ready: that is the `play()` case. A qualified winner that is not ready is elected when its readiness report arrives or when the feed rests, whichever comes first, so a cold create is never forced into a moving frame. The drag/momentum/settle reducer and its FlashList wiring stay as they are.

d. *Split the prepared-window update from the election.* The store publishes the winner's `active` flip immediately and the new window (one mount, one unmount) in a later tick, one native view change per tick, so no commit carries a `play()`, a `VideoView` mount and a `VideoView` unmount together. The existing 100 ms release grace already keeps `release()` out of the unmount frame. The player budget does not change: one active, two prepared, one in grace.

e. *Keep the window shape for now.* `{ ahead, behind }` around the winner stays. A direction-aware window (two ahead while moving, the outgoing one released early) is a second stage only if traces show a mount still overflowing its own frame and Layer 2 has not shipped; it costs direction tracking and a cold restart on reversal.

f. *Dock tint stays a measured variant.* `useTabBarAmbientFeed` decodes a thumbhash per playback report (iOS only) and notifies only when the colour changes; it stays in the experiment table as variant E, not in the fix.

**Layer 2 — native iOS light view (store build).** Mirror `patches/expo-video+55.0.21+002+android-light-player-view.patch` on iOS: a `LightVideoView` whose backing layer is `AVPlayerLayer` (Apple's documented pattern, `override static var layerClass { AVPlayerLayer.self }`), registered as a second `View` in `VideoModule.swift` with `player`, `contentFit` (as `videoGravity`), `contentPosition`, and `onFirstFrameRender` from KVO on `AVPlayerLayer.isReadyForDisplay` ("whether the first video frame of the player's current item is ready for display"). No controls, PiP or fullscreen: every feed-side `VideoView` already passes `nativeControls: false`, `allowsPictureInPicture: false` and `fullscreenOptions: { enable: false }` (`lib/feed-video-view-props.ts`). `VideoManager.onAppBackgrounded` pauses the players of registered views, so the light view registers too (the manager's table is typed to `VideoView`; generalize it). The patched `VideoView.tsx` already routes `nativeControls === false` to a light host on Android; extend that branch to iOS behind the same `supportsLightweightViews` constant. This turns each mount from an `AVPlayerViewController` view load into a bare layer, for the feed and for the reel's first mount (17–62 ms commits in the 09-18 check-up). New binary; it rides the next store build.

**Layer 3 — pooled views (only if 1 + 2 still leave a repeatable hitch).** Mount the `VideoView` unconditionally in video cells and let FlashList recycling keep the native host alive; activation and preparation then only assign `player` (the native prop is `VideoPlayer?`, so nil is accepted; TypeScript needs a cast). Creates leave scrolling entirely, at the cost of idle hosts in memory, an `useExoShutter: false` host keeping its last frame on Android (the poster must cover an idle host), and the loan/return `surfaceGeneration` remount having to survive recycling. Not before 1 + 2 are measured.

### Measure before and after (revised)

- **Device build.** The `scrolltest` bundle in `archive/home-scroll-audit-2026-09-22/` was rejected by iOS; the recipe that launched on 09-17/18 is the `com.athuls.magicbooklet.zoom` one (free team, empty entitlements, `EXUpdatesEnabled` false, built from a space-free worktree). Reuse it instead of debugging the new signing.
- **Attribution, not just counts.** `xcrun xctrace record --template 'Animation Hitches' --attach <pid>`, woken with any `devicectl` call, runs of at most 30 s (the template writes ~100 MB/s of temp). Read the main-thread stacks inside each hitch and classify them: `AVPlayerViewController` init or `loadView`, `didMoveToWindow`/appearance transitions, RN mount transactions, `AVPlayer` release, or none of these.
- **Align with the app's own clock.** Have the build append `{ id, event: 'elect' | 'mount' | 'unmount' | 'firstFrame', t }` lines to `Paths.document` (pulled with `devicectl device copy from --domain-type appDataContainer`), so each hitch is matched to the tile event that caused it rather than inferred from spacing.
- **Same three gestures each run:** a slow drag across a video boundary; a fast fling through several videos; a reverse and stop on a video. Record first-pass against warmed-cache, thermal state, low power and network.
- **Variants.** Keep the table in §2 and add **F: per-tile store, no list re-render (Layer 1a alone)**. If the reading above is right: C (suppress `play()`) keeps the hitches, B (poster-only) removes them, F shrinks the 66 ms one and leaves the single-frame ones, and Layer 1 a–d leaves at most one single-frame hitch per cold create until Layer 2 ships.
- **Android parity.** The S24 shows the same mechanism as `postAndWait` waits and cell recycling in Home flings; use the Perfetto FrameTimeline recipe for a before/after there, because the JavaScript changes ship to both platforms.
- **Simulator.** Functional regression only. The earlier automated drags registered as taps; the simulator control's `touch_path` with per-point delays produces a real slow drag for the "starts while moving" check.

### Acceptance (revised)

- A video whose tile holds a prepared player starts while the feed is still moving, at today's viewability (55 % for 180 ms).
- No repeatable hitch attributable to a tile's activation on the iPhone 16e; after Layer 2, none attributable to a `VideoView` mount either. The numeric targets in §4 and the separate hitch/interaction-delay reporting stand.
- The live player count never exceeds one active plus two prepared plus one in release grace, on either platform.
- The §4 functional checks unchanged: no poster flashes, black surfaces, stuck autoplay, offscreen audio or broken feed↔reel hand-off; refresh, pagination, chip and tab switches, foreground return and failed-media recovery all verified.

### Order

1. Preserve evidence: rebuild the `.zoom`-style device app and capture one attributed baseline (≤ 30 s, three gestures) with the app-clock log.
2. Layer 1a (the store) with tests for per-id notification; measure it as variant F.
3. Layer 1 b–d (readiness, elect-when-ready, split ticks) with controller tests: a ready winner elected mid-motion; an unready winner deferred to its readiness report or to rest; one native view change per tick; the budget held; the existing phase cases kept. Measure on the S24 first, then the iPhone.
4. Explore takes the same store.
5. The Layer 2 patch: iOS simulator smoke, then an iPhone trace; ships with the next store build. Layer 3 only on evidence.
6. The before/after report per §5; OTA for Layer 1, a binary for Layer 2.

What to keep from the current local change: the FlashList drag/momentum wiring, the phase reducer, the `stop`/`reset` handling and the tests that describe phases. What goes: the rule that nothing elects while `scroll !== 'idle'`, and the test that pins it ("does not start passing videos during a fling").


## Objective

Remove repeatable Home scrolling hitches on the physical iPhone without degrading video startup, poster stability, reel transitions, memory usage, or Android behavior. Diagnose before choosing a fix.

## Evidence and limits

- Device: iPhone 16e, iOS 26.6.2; running production MagicBooklet.
- The initial 45-second stationary capture recorded no animation hitches or potential hangs. The user confirmed they did not scroll; this is an idle control, not a passing scroll test.
- The subsequent capture requested 60 seconds of scrolling. Instruments recorded 15 app animation hitches: 14 approximately 16.7 ms and one approximately 66.7 ms. These are hitch durations, not complete frame durations or 15 total dropped frames.
- It also recorded 27 main-thread potential interaction delays, approximately 34–91 ms. Those are a separate measurement and must not be added to the hitch count.
- Ten hitch narratives flagged potentially expensive rendering (11–13 offscreen passes); five flagged potentially expensive app updates. These are diagnostic hints, not established root causes.
- Several render hitches recur about five seconds apart. Video-start timestamps and a synchronized gesture record were not captured, so neither video startup nor a periodic UI task is proven responsible. Confirm the user's activity/perception during this capture before treating it as a repeatable baseline.
- Local source inspected: `ae43c6bbd50f9faedf1278771bc0eecb7cafdb34`. The production binary/OTA has not yet been mapped to this commit.
- Local evidence: `/tmp/scroll-audit/iphone-scrolling-hitches.trace`, `/tmp/scroll-audit/scroll-results.xml`; idle control: `/tmp/scroll-audit/iphone-production-hitches.trace`. Preserve these outside temporary storage before further investigation; keep the large trace out of git.

## 1. Establish a reproducible baseline

1. Record installed app version/build, OTA update/runtime ID, and corresponding source commit. Reproduce that revision in an isolated checkout if different from current source. Do not overwrite the production app with a diagnostic build; use a separately identified release-configured build where feasible.
2. Preserve the existing trace and inspect main-thread call stacks around the 39.658-second hitch and its overlapping 84-ms interaction delay. Symbolicate against the exact binary/dSYM when available. If production sampling lacks useful symbols, capture the matching diagnostic build rather than infer a stack from source.
3. Use the same account, ordered cards and gestures: slow drag across a video boundary, fast fling through multiple videos, reverse direction, then stop on a video. Include a section with image cards.
4. Repeat three 60-second baseline runs with normal autoplay. Separate first-pass and warmed-cache results; record thermal state, power mode, network, and profiling configuration. Keep these comparable across variants.
5. Capture a synchronized gesture/video-start timeline. Use an external view of the phone or time-aligned local markers; avoid adding screen-recording overhead to only one variant.

## 2. Isolate the costs, one variable per experiment

Use local diagnostic switches that default to production behavior. Do not roll diagnostic changes out to users.

| Variant | Change | What it distinguishes |
| --- | --- | --- |
| A | Existing behavior | Baseline |
| B | Poster-only feed; suppress active and prepared players | Overall player/decoder/surface cost |
| C | Keep the same prepared players but suppress `play()` | Playback start versus player creation and view attachment |
| D | Freeze the Home carousel's timer and automatic scrolling | Periodic header work versus feed media |
| E | Disable ambient dock updates/effects locally | Dock/compositing work versus feed media |

Record player creation, release, play requests, first-frame callbacks, active/prepared selection changes, carousel ticks, and drag/momentum boundaries on a shared timeline. Collect React commits in a separate diagnostic pass if their overhead is material. Prefer existing native profiling/signpost facilities and the installed Expo bindings; inspect their availability before adding a native module. Never log signed media URLs or credentials.

Choose fixes only when a trace or isolated variant supports them. A poster-only improvement alone does not prove that `play()` is the expensive operation.

## 3. Candidate fixes, conditional on results

### A. Stabilize Home autoplay and preparation during scrolling

`components/home-dashboard.tsx` currently elects active videos directly in `onPlaybackViewableItemsChanged` and updates prepared anchors as viewability changes. Explore uses the existing `lib/showcase-feed-activation.ts` reducer to defer elections until scrolling rests; Home does not use it.

If traces implicate handoff/player churn, reuse or extract that controller for Home. Drive it from native drag and momentum events, retain stable player identities during motion, and elect the destination once scrolling settles. Preserve the last valid preparation anchor while in motion so gating active playback does not simply move player creation/release churn into the preparation path. Explicitly pause offscreen playback without destroying reusable prepared players. Keep existing limits of one active and two prepared previews and account for the release grace period.

Test slow drags, finger resting before release, fling without momentum callback, rapid reverse drags, interrupted momentum, programmatic jumps, refetch, chip/tab changes, and backgrounding. Reuse native scroll events rather than building a JS animation or per-frame polling loop. The existing controller provides an iOS/Android path; verify both.

### B. Stop invisible carousel work

`TopSlider` advances while Home is focused and its own interaction/reduced-motion conditions permit it. It does not receive vertical header visibility. Its interval is **4,600 ms**, whereas several trace hitches are roughly 5,000 ms apart: this is a candidate, not a timing match.

If variant D removes the periodic render hitches, suspend automatic rotation when the header leaves the viewport or the app backgrounds. Consider suspending during vertical scrolling only if that improves the measured result. Resume without a catch-up animation. Verify visible carousel behavior, reduced motion, page dots, and tab return.

### C. Reduce proven compositing cost

For render-labelled hitches, inspect the layer/render trace to locate the actual offscreen passes. Examine the ambient dock and relevant card clipping/effects only after attribution. Change the responsible effect or invalidate it less often; preserve the intended visual appearance. Do not remove all rounded corners, shadows, or blur based on the offscreen-pass count alone. Any visual change needs simulator/device review and the existing HIG checks.

### D. Fix expensive player lifecycle work if it remains

`components/feed-video-preview.tsx` creates the player in a state initializer and changes buffering/play state in an effect. Inspect creation, surface attachment, buffering updates and release separately.

The installed Expo iOS `VideoPlayer` constructor already loads its initial source asynchronously by default (`node_modules/expo-video/ios/VideoPlayer.swift` and `VideoModule.swift`). Merely substituting `replaceAsync` is not an evidence-based fix. Prefer the existing native AVPlayer/Expo lifecycle and bounded reuse; defer nonessential preparation until a suitable idle point only if measurements justify it. Preserve player loans/returns used by reel zoom transitions, muted audio mixing, retries and first-frame handling. Avoid an unbounded player pool.

## 4. Verification and acceptance

- For any changed pure activation logic, write failing regression cases before the fix, then run the relevant mobile tests and `npm run typecheck` from `ugc-mobile/`.
- Rendering/native performance is accepted on a physical device, not from unit tests. Repeat the same three baseline scenarios and profiling configuration on the iPhone 16e, including first-pass and warmed-cache runs.
- Proposed target: at least 80% lower median total hitch duration per comparable 60-second run and no repeatable hitch above 50 ms. Report event counts and main-thread delays separately. Establish the repeated baseline before interpreting these targets; a single recording is insufficient.
- Require no material regression in cold/warm first-motion latency, memory growth over a five-minute feed session, network use, or live player count. Record baseline values before setting tolerances.
- Verify no poster flashes, black video surfaces, stuck autoplay, offscreen audio, or broken feed-to-reel and reel-to-feed handoff. Check refresh/pagination, tab switches, foreground return, and failed-media recovery.
- Use the iOS simulator for deterministic interaction/regression checks and Android emulator/device for cross-platform player behavior. Use a physical Android device for any Android performance claim.

## 5. Delivery

Keep diagnostics separate from the minimal proven fixes. Save a concise before/after report with build/OTA identity, scenario, device conditions, trace paths, and remaining limitations. Recheck the actual shipped native runtime before choosing OTA versus store build; native patches or new native instrumentation require a new binary. This plan authorizes no production deployment. Complete device verification before proposing release.

Recommended order: preserve/symbolicate evidence → reproduce baseline → isolated carousel and playback experiments → implement the smallest supported fix → repeat physical-device measurements → release review.
