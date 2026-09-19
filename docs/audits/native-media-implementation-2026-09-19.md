# Native media implementation: experiment and verification

2026-09-19. Worktree `media-playback-native`, branch `feat/media-playback-native`, initially based on `21c9aed2` plus the pending release's mobile and display-rendition changes. During this work those inherited changes landed on main as `e451b066` (#180); the branch was then aligned with that baseline. No deployment was performed.

## Delivered

- [Combined Instagram/TikTok research and final architecture plan](../plans/social-media-delivery-final-plan-2026-09-19.md), distinguishing current documentation, historical TikTok measurements, SDK recommendations and unknown private internals.
- An **opt-in experiment**, default disabled, as its own patch at `ugc-mobile/experiments/seamless-loop/patches/expo-video+55.0.21.patch`, applied by hand with `npx patch-package --patch-dir experiments/seamless-loop/patches` (see the probe README): AVQueuePlayer / AVPlayerLooper for supported MP4 playback; existing seek loop for other sources. `EXPO_PUBLIC_SEAMLESS_VIDEO_LOOP=1` enables it only when bundling the local test app. Android remains on the existing engine. It was first written into `patches/expo-video+55.0.21.patch`; the split is recorded under “Audit follow-up” below.
- Compatible player-item replication preserving the same resource-loader asset and logical source identity. An inherited AVPlayerItem copy crashed a minimal Swift subclass probe; blindly adding AVPlayerLooper is unsafe with Expo's original subclass. The custom copy avoids that initializer trap.
- Queue preparation cancellation on source replacement/release; loop-disable position retention; buffer/pitch propagation; source-load event suppression across replicas; native loop signposts; fallback on looper failure.
- A reproducible native fixture probe at `ugc-mobile/scripts/native-loop-probe`, compiling the actual controller, plus raw results in `native-media-2026-09-19/`.
- Close recovery in `components/media-zoom.tsx`: arm the fallback before native source measurement, and ignore measurement callbacks after exit. Previously the timer was inside the callback it needed to protect. A hook regression test simulates a measurement that never answers and then answers late; exit occurs exactly once. This is independent of the queue experiment.

## Results

| Check | Result | Scope |
| --- | --- | --- |
| Mobile TypeScript | Passed | Current source |
| Six focused playback/return suites | 67 tests passed after close-recovery test | JS ownership and existing regression coverage |
| Simulator Release app build | Passed | Native compile/link and bundled JS |
| iPhone Release app build | Passed | Native compile/link/signing, separate test ID |
| Standalone native probe, simulator iOS 26.4 | 21 boundaries in each mode; lifecycle checks passed | Local 30 fps/3-second clip, decoded-output availability |
| Standalone native probe, iPhone 16e iOS 26.6.2 | 21 boundaries in each mode; lifecycle checks passed | Same fixture; no audio |
| Integrated iPhone short-video navigation | Two scripts completed; native loop signposts confirmed playback | These coordinate scripts did not assert the final screen, so they do not certify close completion |
| Integrated iPhone rapid open/close test | Passed 30 Explore cycles with queue flag on and 30 more with normal flag off, 0.25–0.85 second holds | XCUITest required the viewer back button to appear and disappear on every cycle; snapshots every fifth return; functional return, not frame pacing |
| Integrated simulator viewer test | Not passed | Test app returns to sign-in; requested user sign-in |

Physical probe: seek-loop median boundary **49.98 ms**, maximum **66.61 ms**. Queue-loop median **49.96 ms**, maximum **49.99 ms**. Queue mode reached **five enqueued items**, compared with one item for seek mode. Items are not equivalent to measured hardware-decoder counts. The test reports decoded sample availability sampled on CADisplayLink; it is not an on-screen frame-presentation measurement.

The integrated iPhone trace confirms `VideoLoopAdvance` signposts from the patched engine. At two sampled boundaries (trace times 2.925 and 5.960 seconds), the busy display surfaces had approximately 100 ms swap gaps among a roughly 66.7 ms cadence. This brief run is insufficient for attribution or comparison with the old engine, but it **does not demonstrate that the observed loop hiccup has been eliminated**. Do not promote the experiment based on the standalone result.

The initial rapid-cycle harness failed: one selected a nonvisible old feed target and another began while still in a viewer. Those were test setup errors, not a demonstrated player crash. The corrected harness started on Explore and selected its visible “Motion creation” tile. With the close recovery fix in the device build, the first six cycles passed with return screenshots; a follow-up 30-cycle run asserted the viewer back button appeared and disappeared on every cycle and saved snapshots every fifth return. The same 30-cycle test also passed after rebuilding and reinstalling with the queue flag **off**, the normal bundle setting. This establishes functional return in that path; it does not isolate which part of the close animation dropped frames, or prove that native measurement had hung in the earlier run.

## Decision: do not enable the queue experiment in production

The median gain is negligible in the controlled physical probe, resource usage is higher, and integrated presentation has not met the acceptance gate. Keep the experiment isolated and disabled. An upcoming native build should prioritize measured resource scheduling and view-mount work; native technology alone is not proof of improvement. A custom sample-buffer engine requires a separate justified prototype, not an assumption that it will be smoother.

The broad native preparation scheduler, lightweight Android host and conditional native pager in the plan **are not implemented**. Neither CDN migration nor production rollout occurred. Remaining checks include an exact-release A/B comparison, audio/seeking/DRM/HLS fallback behavior, 100-cycle resource soak, 120 Hz hardware, low-power/thermal cases, and per-entry Home/Explore/Profile transitions. These are explicit unfinished gates, not implied successes.

## Reproduction and local evidence

Evidence bundle: `archive/ugc-app-audits/native-media-2026-09-19/` at the workspace root, copied out of `/tmp/magicbooklet-loop-probe/` on 2026-09-19 because `/tmp` does not survive a restart. It holds the XCUITest results, `integrated-loop.trace` with its exported tables, run logs, screenshots, the probe project and the generated fixture. The app builds, DerivedData, Metro caches and the multi-megabyte build logs were left in `/tmp`. The queue-on 30-cycle run is `device-recovery-30.log` and `.xcresult`; the normal flag-off run is `device-normal-30.log` and `.xcresult`. The six-cycle predecessors are `device-recovery-rapid.log` and `.xcresult`, with `rapid-final.png` showing its final screen. Test app bundle ID: `com.athuls.magicbooklet.zoom`; fixture app: `com.athuls.magicbooklet.loopprobe`. Production bundle ID was not replaced.

The generated CocoaPods build phase failed on the space in this workspace path; its local, ignored project was adjusted to quote the script invocation. The first bundle failed the existing RevenueCat environment guard because `.env.local` had empty public keys; the pre-existing `.env.production.local` was copied into the isolated checkout. The guard was retained. A private Metro TMPDIR was used. Expo Updates is disabled in the local generated test project so it runs its bundled experiment.

Raw fixture JSON is retained in the repository for review. Native controller source evolved after the fixture run to add failure recovery/signposts; the integrated device build includes those changes. Fixture numbers should not be claimed as a test of the full Expo subclass or network cache. The simulator integrated build preceded the final failure-recovery observer; rebuild it before final feature validation.

## Audit follow-up, 2026-09-19

- **Patch split.** The looper hunks were carved out of `patches/expo-video+55.0.21.patch` into `experiments/seamless-loop/patches/expo-video+55.0.21.patch`. The shipped patch is byte-identical to `main` again, and the two files concatenated hash to the combined file this document was written against (`872190a8…`; both new hashes are in `evidence.json`). Reason: `@expo/fingerprint` hashes `patches/` and the autolinked `node_modules/expo-video/ios` for both platforms. With the combined patch the worktree fingerprinted iOS to `59ba532f`, against the shipped build 52’s `c2e22bfa`, so landing it on `main` would have stranded every JS-only iOS update until build 53 ships. With the experiment reversed, `node_modules/expo-video/ios` is file-for-file identical to the primary checkout on `main` and `verify-ota-target.mjs` reports iOS `c2e22bfa`, safe to publish; re-applying the experiment restores the exact tree the builds above used. The worktree was left with the experiment applied.
- **Plan corrections** in the final plan: the branch baseline (created from `21c9aed2`, reset onto `e451b066`); an over-the-air mount and draw-list step ahead of a now-conditional preparation scheduler; a loop gate of one source-frame interval in total, read from presentation; the fixture caveat on the looper result; and the expo-video prebuilt-AAR trap for any Android Kotlin patch.

## S24 A/B, 2026-09-19 (afternoon): what a reel frame costs

Method: `.dev` release APKs built from `main` (`e451b066`) plus each change in the primary checkout’s warmed `android/` (`scripts/build-dev-apk.sh` in the archive folder), installed on the S24 Ultra, the kungfu-cats Explore reel opened for 13 s under a 22 s Perfetto trace (FrameTimeline, atrace, REC markers; `loopcats.py`), read with `loopcompare.py` over [OPEN + 2.5 s, BACK − 0.3 s] and `phase.py` / `gapwhere.py` over the open [+0.05 s, +1.6 s] and close [+0, +0.7 s] windows. APKs with sha256, all eight traces and the scripts: `archive/ugc-app-audits/native-media-2026-09-19/s24-ab-2026-09-19/`.

| Build | RenderThread median / p90 (ms) | prepareTree | syncFrameState | Draw ops per frame |
| --- | --- | --- | --- | --- |
| `main` ×2 | 8.6 / 16.0; 9.5 / 18.6 | 2.21 | 3.44 | 12 texture, 12 rect, 6 text, 6 rounded rect, 4 circle |
| rail + caption as cached layers ×4 | 9.4 / 16.0; 9.6 / 15.3; 9.0 / 15.5; 7.6 / 15.5 | 2.76–3.01 | 4.04–4.36 | 10 texture, 12 rect, 2 circle |
| hidden tab screen out of layout ×4 | 7.7 / 16.9; 7.9 / 16.1; 7.3 / 13.9; 9.7 / 16.8 | 1.44–1.77 | 2.59–2.70 | as `main` |

- **Draw ops are not the cost.** Every `*Op` slice together is about 0.6 ms of a 9 ms frame; the frame is the tree walk (`prepareTree`, inside `syncFrameState`) and the display-list replay over some 1,300 views. The cached layers removed 14 ops per frame and changed nothing else, added 0.8 ms to the walk, and put their allocations into the open window (late frames 17–23 against 11–12). Reverted the same day; the plan’s “rail as cached bitmaps” item is closed as a negative result.
- **Taking the hidden tab screen out of layout** (`lib/zoom-underlay.ts`: `display: 'none'` 450 ms after hiding, back in the same call that shows it) ends its walk: prepareTree −0.5 to −0.8 ms, syncFrameState −0.8 ms, median about −1 ms. A marker build placed the detach at +1.4–1.5 s after the tap with no stall of its own, and the close window showed no new stall in four runs (busy gaps of 42–158 ms appear in every build there: the hand-back’s `PlayerView` inflate). After a close the grid is back (accessibility dump). Shipped on this branch, Android only.
- **The refresh-spinner delay is neutral here.** The open window’s stalls, 25–34 ms `IntBufferBatchMountItem::mountViews` at +0.5–0.6 s, are the neighbour slide mounts in every build. Kept as product behaviour (the reel opens onto content), not as a performance claim.
- **Noise:** the median moves ±1 ms between identical runs (7.3–9.7 within one build); read the component slices.
- **Next lever:** view count. Instagram’s reel frame walks 144 views; after the detach ours still walks the reel’s own ~850 for three slides (each rail icon is two SVG trees for its shadow, and both neighbours carry full chrome).

## Steps 1, 3, 4 and 5 on the S24, 2026-09-19 (later)

Same method and folder as the A/B above (`swipes.py`, `nextframe.py`, `inflate.py`, traces `swipes1`, `playerviewA/B/S`, APK `playerview.apk`).

- **Step 1, next-video gate.** Four swipes on the branch build: the next video’s prepared frame is on screen through the swipe; its player renders within 2–26 ms of the swipe input; motion resumes about 130 ms after the snap (swipe 120 ms + settle); no decode gap over 45 ms in the following 1.5 s. Late frames per 1.2 s swipe window: 4–26, the motion’s own per-frame cost. **Step 4 is therefore skipped** by the plan’s rule.
- **Step 3, where the views are.** `dumpsys activity top` with the reel up: 1,760 views, 1,627 visible, of which the detached tab screen’s 424 are under an INVISIBLE root and not walked, and 113 are GONE. Icons: 96 `SvgView` roots with 358 descendants (each lucide icon is Svg + Group + paths; `IconShadow` doubles every bare rail icon). Three `PlayerView`s at 38 descendants each. The reel’s three slides are about 290 views each. Next cut: the rail’s icons as prebaked bitmaps, one image view apiece instead of two SVG trees, which also removes the ~16 ms of SVG trees from the landing mount.
- **Step 5, lighter Android host.** `plugins/withAndroidLightPlayerView.js` with the layouts in `plugins/android-light-player-view/`, tested by `__tests__/android-light-player-view.test.ts`, measured by dropping the layouts into the generated project: `PlayerView` descendants 38 → 6; creation on the UI thread (`createViewUnsafe` → `PlayerView`) at the open 21.9 / 10.3 / 4.6 → 3.0 ms (first creation after launch stays noisy: 10.8 once), neighbours and hand-back 5.1 / 4.9 → 1.4–2.5 ms; steady state unchanged; video plays (1,256 decoded frames in the window, screenshot 88% non-black); no app crash in logcat. Not registered in `app.json`: that is the store-build commit, since it moves both fingerprints.
- **Still owed:** step 2’s iOS A/B (build `com.athuls.magicbooklet.zoom` from this worktree with `EXPO_PUBLIC_SEAMLESS_VIDEO_LOOP=1` and without, `run_part.sh loop` under Instruments, `swapgaps.py` on the display-surface queue at the loop boundaries of a production clip); step 3’s icon bitmaps; step 6.
- The S24 was left on `playerview.apk` (branch JS plus the light layouts).

## Completion pass, 2026-09-19

- **Viewer rendering:** static reel glyph variants are generated from the pinned Lucide shapes into `ugc-mobile/assets/reel-icons/`. The viewer keeps the same size, colour, fill, shadow and hit target, while the Android reel can use image nodes instead of the duplicated SVG trees. Custom icon variants continue to use SVG. The generation script is `ugc-mobile/scripts/generate-reel-icons.mjs`; Lucide's ISC license is included with the assets.
- **Refresh feedback:** an automatic viewer refetch waits 900 ms before showing its spinner, while a refresh explicitly requested from the More sheet shows feedback immediately. This keeps normal landing work out of the first transition frames without hiding a user-requested action.
- **Android native host:** the first app-wide layout override was corrected. The new experiment adds separate controls-off native view classes and uniquely named layouts, so creation previews and the media lightbox retain Expo's full native controls. The source patch removes expo-video's prebuilt Android publication and compiles the Kotlin changes. The release APK built successfully after freeing temporary build output and launched on the connected S24. A full frame trace of the new host still needs to be captured; the attempted scenario runner was stopped before producing a trace.
- **iPhone playback:** the normal flag-off 70-second real-clip test passed and returned to Explore. The Instruments trace ended with a tooling assertion while exporting, so it is retained as a functional result only; it is not used as a frame-pacing claim.
- **Verification:** mobile typecheck passed, the full mobile suite passed (242 files / 2,399 tests), patch application checks passed for the existing Expo patch, the Android release APK compiled, installed and launched. Production was not changed.
