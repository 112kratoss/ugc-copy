# Native media implementation: experiment and verification

2026-09-19. Worktree `media-playback-native`, branch `feat/media-playback-native`, initially based on `21c9aed2` plus the pending release's mobile and display-rendition changes. During this work those inherited changes landed on main as `e451b066` (#180); the branch was then aligned with that baseline. No deployment was performed.

## Delivered

- [Combined Instagram/TikTok research and final architecture plan](../plans/social-media-delivery-final-plan-2026-09-19.md), distinguishing current documentation, historical TikTok measurements, SDK recommendations and unknown private internals.
- An **opt-in experiment**, default disabled, in the existing expo-video patch: AVQueuePlayer / AVPlayerLooper for supported MP4 playback; existing seek loop for other sources. `EXPO_PUBLIC_SEAMLESS_VIDEO_LOOP=1` enables it only when bundling the local test app. Android remains on the existing engine.
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

Scratch bundle: `/tmp/magicbooklet-loop-probe/` contains simulator/device app builds, XCUITest results, `integrated-loop.trace`, logs and the generated fixture. The queue-on 30-cycle run is `device-recovery-30.log` and `.xcresult`; the normal flag-off run is `device-normal-30.log` and `.xcresult`. The six-cycle predecessors are `device-recovery-rapid.log` and `.xcresult`, with `rapid-final.png` showing its final screen. Test app bundle ID: `com.athuls.magicbooklet.zoom`; fixture app: `com.athuls.magicbooklet.loopprobe`. Production bundle ID was not replaced.

The generated CocoaPods build phase failed on the space in this workspace path; its local, ignored project was adjusted to quote the script invocation. The first bundle failed the existing RevenueCat environment guard because `.env.local` had empty public keys; the pre-existing `.env.production.local` was copied into the isolated checkout. The guard was retained. A private Metro TMPDIR was used. Expo Updates is disabled in the local generated test project so it runs its bundled experiment.

Raw fixture JSON is retained in the repository for review. Native controller source evolved after the fixture run to add failure recovery/signposts; the integrated device build includes those changes. Fixture numbers should not be claimed as a test of the full Expo subclass or network cache. The simulator integrated build preceded the final failure-recovery observer; rebuild it before final feature validation.
