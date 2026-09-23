# Home scroll stutter: follow-up after build 6

> Archived 2026-09-23. The set-once buffer target shipped with the Home work in #195, measured on its exact JavaScript first (see "September 23: the release candidate" at the end). The loader backport and the light video host stay experiments in `ugc-mobile/experiments/`. Kept as the investigation record; it superseded the proposed next steps in [the September 22 log](home-scroll-hitches-2026-09-22.md).

## Required behavior

Videos should begin while the reader scrolls slowly through Home, using the existing visibility qualification. A prepared video must not wait for finger lift or momentum end. A cold video may show its poster while loading, but scrolling must not indefinitely postpone its loading or playback. Preserve one active and two prepared players, bounded release grace, muted playback, and feed/reel handoff.

## What has already been tried

The working tree and investigation log now contain per-card activation subscriptions, readiness-driven playback during motion, a staggered prepared window, an experimental iOS AVPlayerLayer host, reduced card/shadow rendering work, a paused carousel during scrolling, fast-coast preparation hold, and prepared-window hysteresis on reversals. Do not restart this work by proposing those same changes as untested solutions.

- The log reports no consistent improvement in early store/build 3/build 4 hitch comparisons. Different ranked posts between launches weakened those comparisons.
- Build 6's reversal test improved sampled creation activity and measured gaps, but the owner still reports visible stutter. Reduced work has not established an acceptable experience.
- Reduce Transparency made no felt difference to the owner. Removing the glass dock is not the default next fix.
- Later profiles identify three leads: video source/asset creation and media-server waits; React Native's clipped-subview traversal; render work. CPU gradient drawing appeared near test boundaries, so its contribution during ordinary scrolling remains uncertain.
- The primary checkout's native dependencies are not the same as the experimental device build: the lightweight iOS host lives in an experiment patch applied in a separate build tree. Record the installed binary and applied patch manifest before attributing results to source.

## 1. Make the reproduction and measurements trustworthy

Use the existing working `com.athuls.magicbooklet.zoom` release-test recipe and the connected iPhone. Keep the production app intact. Record source snapshot, dirty patch, native patch set, bundle/build, runtime/OTA identity, binary/dSYM, device OS, thermal state and power mode. Preserve files under `archive/home-scroll-audit-2026-09-22/`, outside git. Earlier `/tmp` traces are gone; do not cite them as available for fresh stack analysis.

Freeze a small, authorized feed fixture in the diagnostic build: identical card order, sizes, video sources and posters for every variant. Do not compare newly ranked For You results across launches. Keep credentials outside fixture logs. Include:

1. The owner's small up/down reversal on the same two video cards, after both are fully prepared.
2. Slow continuous dragging across a new video boundary, including finger held down after the tile qualifies.
3. A fast fling followed by reversal and a stop on a video.
4. A matched image-only section as a control.

Run at least three short captures per variant, alternating baseline/candidate order, with separate cold and warm sessions. Use the same gesture path and profiling overhead. Short 20–30 second captures avoid the existing trace-size problem; exclude setup and post-test accessibility snapshots from the measured interval. Include the owner's manual reproduction, since scripted flings did not reproduce their experience well.

Capture User Events, Commits, Renders, Frame Lifetimes and main-thread running/waiting intervals. Synchronize native monotonic signposts for gesture/scroll boundaries, selection, player creation/release, item replacement, view attachment and first frame. Add diagnostic native scroll-position markers sparingly enough to avoid creating the problem. A JS `play()` call or `playingChange` alone does not establish visible motion. Use a separate external high-frame-rate video pass when needed to verify that the same card edge stalls while the finger continues moving. These tracks follow [Apple's profiling guidance](https://developer.apple.com/documentation/xcode/improving-app-responsiveness).

### Correct the interpretation of the existing helper scripts

`motion_gaps.py` is a screening heuristic. It detects render-start gaps near app commits, assumes 60 Hz, estimates moving time from commit counts, and discards gaps longer than five refreshes. It does not directly measure scroll displacement, actual presentation, or continuous user motion. Reversal pauses and unrelated commits can affect the result. Its numbers must not be called confirmed frozen-frame duration until correlated with the display/input timeline; longer stalls must not be silently discarded.

`rock_read.py` counts sampled `VideoAsset.init` / `LightVideoView.init` bursts separated by 250 ms. The reported 7 → 2 is a reduction in observed bursts, not an exact native player allocation count. Instrument exact create/release events before enforcing a resource budget from these numbers. Likewise, Time Profiler sample percentages describe CPU activity, not a percentage of visible stutter; blocked time needs its own trace.

Report official hitch duration/rate, confirmed visible stalls and startup latency separately. Do not add these metrics together or declare a pass because the Hitches table is empty. [Apple distinguishes commit and render work in its render-loop explanation](https://developer.apple.com/videos/play/tech-talks/10855/).

## 2. Choose the next patch from a controlled experiment

Keep the latest build as the initial baseline; preserve each variant independently. Do not accumulate another set of unrelated optimizations before measuring.

| Experiment | Isolated change | Decision it enables |
| --- | --- | --- |
| Warm reversal | Hold the same two prepared players and native hosts throughout the two-card gesture; log that no replacement occurs | Stutter remaining here cannot be explained solely by cold player creation |
| Video control | Same fixture/layout/posters with feed player creation and playback disabled | Distinguishes total media contribution; diagnostic only, never the proposed UX |
| Loader candidate | Same baseline plus the compatible upstream Expo loading changes | Tests source loading and AVFoundation setup at new-card boundaries |
| Traversal candidate | Same baseline plus a narrowly scoped React Native traversal change, only after stack attribution | Tests persistent scroll cost when no media is created |
| Render candidate | One trace-identified gradient/effect changed at a time | Tests actual render-phase cost without treating offscreen-pass count as proof |

If warm reversal stutters, inspect that interval first. If the video-disabled control also stutters, prioritize traversal/render/input work over further playback scheduling changes. If only new-card transitions stutter and their waits align with media loading, prioritize the loader candidate. If neither reproduces, capture the owner's exact gesture before changing more code.

## 3. First native candidate: Expo's upstream video-loading change

[Expo PR #47975](https://github.com/expo/expo/pull/47975) explicitly addresses main-thread load: it introduces a dedicated loading actor, eagerly loads additional asset properties, and avoids redundant AVPlayer assignment. This is a stronger lead than another JS delay, but the maintainers describe a modest improvement, not a universal cure.

The installed `expo-video` 55.0.21 has no `VideoLoadingActor`; `VideoPlayerItem` loads only duration, transform and playability, and `VideoView.player` assigns the controller's player unconditionally. The initial constructor already takes an asynchronous path. Therefore replacing `createVideoPlayer` with another async call is insufficient evidence of moving native work off the main thread.

Implementation experiment:

1. Compare the upstream patch with SDK 55's Swift/concurrency settings and the existing range-cache, cache-ownership and lightweight-view patches. Prefer a compatible supported release if available; otherwise prepare a minimal, separately reversible backport. Do not blindly install a different SDK's package.
2. Move appropriate asset/item/track preparation to the explicit loading executor; preserve cancellation and stale-source protection. Keep AVPlayer item replacement, view/layer mutation and required observer interactions on their required thread.
3. Apply the same-player identity guard where relevant. The lightweight feed host bypasses AVPlayerViewController, so that guard alone cannot cure its feed stutter.
4. Measure main-thread loading/waits and cold/warm first-frame latency on the actual feed MP4 and any HLS fallback. Verify cache hit/miss, signed-source renewal, failure/retry, backgrounding and feed/reel loans. Confirm source dimensions/codec and that the existing feed rendition is actually used before proposing new transcoding.

This requires a new native test binary. A JS timeout or Promise cannot guarantee a native operation executes off the UI thread. [Expo documents preloading separately from a VideoView](https://docs.expo.dev/versions/v55.0.0/sdk/video/); buffering bytes is also distinct from attaching a surface and displaying its first frame.

## 4. Second candidate: React Native traversal, if warm-scroll traces implicate it

Installed React Native source confirms `_remountChildren` runs after mounting and during scrolling, with an `enableViewCulling` early exit. The generic clipped-subview helper converts coordinates and recurses. The log's sampled traversal cost makes this a candidate, not an established explanation for every missing frame.

- First verify whether a compatible upstream fix exists and whether the test binary uses prebuilt React Core. A source edit has no effect on an already compiled framework.
- Prefer a supported fix or a narrow from-source patch over global method swizzling or blindly enabling a feature flag. A safe skip must account for all descendants that need clipping, including navigation screens and nested lists; a parent's `removeClippedSubviews=false` alone is not sufficient.
- Verify the changed implementation is in the binary. Compare the same warm-reversal scenario with the same Expo/media configuration.
- Test nested lists, offscreen navigation screens, mounting/unmounting clipped children, tab switches, memory and visible missing-content regressions. Keep the normal traversal where correctness cannot be established.

If traversal accounts for CPU but its reduction does not improve confirmed visible stalls, do not ship it as the stutter fix. [FlashList's recycling guidance](https://shopify.github.io/flash-list/docs/fundamentals/performance/) supports avoiding unnecessary remounts; the current per-card subscriptions and window retention already address part of that concern. Removing generation keys without replacing their stale-source, retry and loan safeguards would be a regression.

## 5. Render changes only against a named expensive interval

Inspect per-frame duration and the actual layer/GPU work. Offscreen-pass count alone did not predict cost in the logged results. Only change the carousel gradients if CPU drawing coincides with the owner's scroll stall; verify the installed RN gradient API and output before replacing it. Retain the existing carousel visibility/scroll pause unless it causes a regression. Do not repeat the glass/Reduce Transparency test as if it had not already been tried.

No new full player pool or permanent host architecture unless the traces still show repeatable lifetime cost after the simpler native candidate. Player reuse must preserve source/auth identity, generation guards, the existing loan/return ownership and Android's surface-reattachment behavior. [Apple's AVPlayerLayer](https://developer.apple.com/documentation/avfoundation/avplayerlayer) was already used in the lightweight-host experiment; proposing it again is not the next step.

## Acceptance and delivery

- The owner repeats the original up/down gesture and slow video-boundary scroll on the iPhone and confirms the visible issue is gone. Record residual stalls honestly; no claim of completion from reduced counts alone.
- Across the matched repeated runs, confirmed visible stall time improves beyond baseline variation, with no recurring stall over 50 ms or repeatable activation stall. Establish the baseline spread before selecting an exact relative target. Keep official hitch metrics alongside the visual measurements.
- Prepared videos visibly start before finger lift at the existing viewability threshold. Cold-source first-frame latency must not worsen beyond baseline variation merely to improve scroll metrics.
- Exact live-player accounting stays within the intended budget, including release grace and loan ownership. A five-minute session shows no continuing memory growth, leaked players, or unintended network growth.
- Verify posters, first-frame reset on source changes, retries, refresh/pagination, tab/chip switches, background return, muted audio and feed/reel handoff. Run regression tests for changed logic and mobile typecheck. Simulator checks cover behavior; physical-device measurements establish performance. Test Android behavior for shared JS changes and use a physical Android device for Android performance claims.
- Retain only changes with supported benefit or independent correctness value; reassess timers and scheduling complexity that experiments do not justify. Record accepted/rejected variants and exact build identities in a short before/after report.
- Native patches need a new store binary and runtime record. JS-only delivery is possible only for an exact supported runtime, using the repository's OTA publisher. Deployment is a separate step after validation.

## Recorded experiment results

The fixed fixture and separate Release app were used on the iPhone 16e. R7-A1
(video) and R7-P1 (posters only) each produced two small render hitch events,
33.3 ms total, during roughly 15.6 seconds of repeated held scrolling. Neither
had moving display-link callback gaps above 25 ms. No players were created in
the video run's measured warm-reversal interval. This does not rule out media
cost at new-card boundaries.

The continuous synthetic gesture produced roughly 50–83 ms callback delays
even without profiling. It is not a faithful enough replacement for the owner's
gesture to establish visible stutter: the early R7-A3 screenshot overlapped
the gesture and later runs still have possible input-synthesis effects. Do not
promote that callback metric to confirmed frozen-frame time.

A diagnostic deferred-coordinate-conversion traversal reduced sampled clipping
work but did not remove those delays (R7-C2). It is rejected as the next shipping
fix; the runtime swizzle stays outside product source.

The upstream loader candidate compiled and moved all measured asset creation
off the main thread. R7-N1 versus R8-N1/R8-N2 did **not** show consistent scrolling
improvement. The patch remains an opt-in experiment, documented in
[`ios-video-loading/README.md`](../../ugc-mobile/experiments/ios-video-loading/README.md).
Main-checkout mobile tests and typecheck passed; no native performance acceptance
is inferred from them. Thread-state recording is the next diagnostic step to
separate CPU work from blocked/idle intervals around delayed callbacks.

The temporary build tree/test runner was cleared between sessions. The runner
has been restored under the durable audit directory; the installed diagnostic
app, baseline app, traces and source-hash manifest remain available. R8-T1 had
no gestures because its runner path was missing and is not a valid scroll test.

Do not ship the existing collection of experiments as a proven fix.

### September 23: thread-state attribution

R8-T3 is the first synchronized, valid thread-state capture. The test runner
announces readiness before the app is launched and the recording is attached;
the fixed-card measured drags fall within the recording. R8-T2's scrolls began
after its recording ended and are excluded from stack attribution.

Three moving display-link callback gaps were 82.6, 43.3 and 49.2 ms. Main-thread
blocked time inside them was 79.27, 38.67 and 46.02 ms respectively; running time
was only 2.26, 4.14 and 2.38 ms. The dominant wait stack is:

```text
__avplayeritem_fpItemNotificationCallback_block_invoke
  -[AVPlayerItem _loadedTimeRanges]
    itemasync_CopyProperty
      _dispatch_sync_f_slow
        __DISPATCH_WAIT_FOR_QUEUE__
```

In the longest gap, queue ownership accounts for 63.87 ms, followed by a
14.08 ms synchronous Fig/XPC property request. Concurrent media-worker waits
include `remoteXPCPlayer_SetRateWithOptions` and `remoteXPCItem_SetProperty`;
Expo's audio-session queue also waits on audio-session property reads. This
identifies the blocking path for these three delays, not the underlying reason
the media service took so long. It does not establish that all owner-visible
stutters have the same cause.

The callback is internal to AVFoundation. The feed already disables periodic
time events; Expo's explicit `bufferedPosition` getter is not on this stack.
Removing that getter or moving a JavaScript callback would not address the
recorded path. No private AVFoundation method is patched.

Evidence: `R8-T3.trace`, `R8-T3-scroll.json`, `R8-T3-waits.txt` and `gap_waits.py`
in the durable audit directory. Exact recorded player count peaks at four during
release grace and returns to three in these short new-card runs; this is not a
five-minute leak test.

Next isolated diagnostic: fixed 8-second buffer target for prepared and active
feed players, avoiding the current 3-to-8-second changes during every playback
handoff. This tests a possible source of media property work while preserving
autoplay during scrolling. It is an experiment, not an accepted fix. Both R9
variants reuse the preserved R7 native baseline and differ only in a compiled
diagnostic buffer flag, with new signed embedded bundles in the separate test
app. The discarded loading candidate is not combined with this experiment.

### September 23: the fixed buffer target, repeated

R9 plus R10 compare the two R9 apps on the same R7 native binary, fixture and
gesture (`fixed-cold`: six slow held drags onto new video cards). R10 runs were
unprofiled and alternated baseline and fixed; R9 ran under Time Profiler. The
table counts display-link refreshes the main thread missed while the offset
changed, from consecutive `link.timestamp` steps (`vsync_misses.py`), next to
the callback-gap reading used above (`read_fixed.py`).

| Variant | Runs | Missed refreshes per run | Longest callback gap | Callback excess over 25 ms |
| --- | --- | --- | --- | --- |
| 3 s prepared, 8 s playing, changed at every handoff | R9-B1, R10-B2, R10-B3, R10-B4 | 5, 7, 4, 5 | 70.4, 79.2, 52.7, 62.5 ms | 101.6, 136.8, 87.1, 93.6 ms |
| 8 s for the player's whole life | R9-F1, R10-F2, R10-F3, R10-F4 | 0, 0, 0, 0 | 23.5, 25.8, 26.1, 25.4 ms | 0, 9.2, 18.5, 8.8 ms |

The two sets do not overlap. Every earlier baseline-shaped run (R7-N1, R8-N1,
R8-N2, R8-T2, R8-T3) also had a callback gap of 40 ms or more. Player creation
and release happened at the same moments and in the same numbers in both
variants (three of each), so creation alone does not explain the baseline's
stalls. On the event timeline (`gap_timeline.py`), each baseline stall starts
40–60 ms before the window step that releases one view and creates the next
player, which is where a handoff lands. The fixed variant's remaining late
callbacks (about 26 ms, no missed refresh) coincide with that release and
creation instead.

This is consistent with R8-T3's blocked stack. `bufferOptions` sets the item's
`preferredForwardBufferDuration` and the player's
`automaticallyWaitsToMinimizeStalling`. The JavaScript thread sets them next to
`play()` or `pause()` at every handoff; R7-A1 sampled those setters there. In
R8-T3 the main thread waits for the player's queue in
`-[AVPlayerItem _loadedTimeRanges]` while media-server `SetProperty` and
`SetRateWithOptions` requests hold it. The 3-to-8-second change arrived with
prepared players in #176 (2026-09-17).

Product change (JavaScript only; committed as 0014fc1b in PR #193): `FeedVideoPreview` sets
`FEED_PREVIEW_FORWARD_BUFFER_SECONDS` once when it creates a player, and a
handoff only resumes or pauses it. `FEED_PREPARED_FORWARD_BUFFER_SECONDS` is
gone. A regression test fails if a handoff writes `bufferOptions` again
(positive control run). The mobile suite (2,495 tests) and typecheck pass. The
cost is at most 5 s more of a clip that is prepared and then skipped. The
fixture's feed renditions run 3–15 s at 0.35–1.5 Mbit/s, so that is under
1 MB per skipped clip. Android applies the same constant through ExoPlayer's
load control; it is unmeasured there.

R11 repeats the owner's gesture on the same two apps: `fixed-warm`, three
down-and-up swings of half a screen between the paper-boat video and the
"dance" video below it, both already prepared. Six unprofiled runs alternated
baseline and fixed. None missed a refresh: the longest callback gaps were 19.6,
21.6 and 28.7 ms for the baseline and 26.4, 19.8 and 25.1 ms for the fixed
buffer. No player was created or released while rocking, so build 6's window
hysteresis holds. The fixed buffer changes nothing here: a handoff between two
players that finished loading long ago does not stall, even when it changes
their buffer targets. The likely reading, not yet shown by a trace, is that
the stall needs a handoff that meets a player still loading. Arriving at a new
card produces exactly that.

R13 checks the same change on the real For You feed. Both variants use the main
checkout's JavaScript on the R7 native binary; the only diagnostic addition is
the `startScrollProbe()` call, added in the build tree only. B6p restores the
per-handoff buffer and B7p is the change. Each got three alternated,
unprofiled `fixed-cold` runs, each run building two players. B6p missed 3, 2
and 3 refreshes, with longest callback gaps of 64.9, 48.5 and 45.2 ms. B7p
missed none, with longest gaps of 27.9, 26.7 and 20.6 ms. R12 is invalid: its
bundles lacked the probe start, so its copied probe file was the previous
run's (`R12-INVALID.txt`).

`B7.app` (the change, no probe) is installed on the iPhone for the owner's
feel test. It carries the whole uncommitted working tree on the R7 native
binary, which includes the light video host. The buffer change itself is
JavaScript only.

`B9.app` replaced `B7.app` on the iPhone the same day. It adds a fix for a
separate bug the owner reported: sound kept playing after a video was closed
with a back swipe. Native-stack removes the reel from navigation state, and
the zoom hands its player back to the tile (which mutes it), only once the pop
transition ends. On the iPhone that was 0.6–1 s after the finger lifted,
measured with a diagnostic build that logs every player's state
(`A1`/`A2-audio-debug.log`). The reel now goes silent on `transitionStart` with
`closing: true`, which arrives while the swipe is still under way
(`lib/use-screen-leaving.ts`, `ViewerLeavingContext` in `app/viewer.tsx`). The
video keeps moving into its tile, and a cancelled swipe restores the sound. The
loan module also mutes a player when the reel hands it back or ends its loan.
With the fix (`A3`), the mute landed 30–200 ms after each gesture close
started. The buffer change and this fix are both JavaScript only; the sound fix is 72616ff1 in the same PR.

### September 23: the Galaxy S24 Ultra

The same slow drags onto new Home videos ran on the S24 (120 Hz). Each run
recorded a Perfetto FrameTimeline trace (`android-ab/drive_home.py`). The
three `.dev` builds were alternated: A6r (working tree without the buffer
change), A7 (with it) and the 2026-09-19 `.dev` build (Z). A stall counts only
when the UI thread or RenderThread was busy for most of it (`home_frames.py`).

| Build | Busy stalls per run | Time lost per run (about 17 s of drags) | Longest stall |
| --- | --- | --- | --- |
| A6r (B2, B3) | 30, 31 | 408, 408 ms | 50, 50 ms |
| A7 (F1–F3) | 33, 29, 26 | 424, 408, 375 ms | 50, 58, 50 ms |
| 2026-09-19 (Z1–Z3) | 25, 37, 20 | 416, 524, 350 ms | 75, 67, 50 ms |

B1 is excluded: it ran just before a USB reconnect and presented a third fewer
frames than any other run. Within this spread, neither the buffer change nor
the uncommitted Home work changes Android scrolling. The stalls have the same
make-up in every build (`gap_slices.py`). Most of the time is RenderThread
drawing and Vulkan flushes, then the UI thread waiting on the RenderThread
(`postAndWait`), injected-input dispatch and Fabric view mounting. No media
work is among them. Android's remaining stutter is render cost, a different
problem from the iPhone's media-server waits.

After a back swipe out of the reel on the S24 (A9: both fixes), the reel's
player paused within about 0.5 s. AudioFlinger showed the Home tile's resumed
track at −inf dB (silent). AudioService's `mutedState` does not report
ExoPlayer's volume-0 mute, so read `dumpsys media.audio_flinger` to check.
A9 is installed as the `.dev` app.

### September 23: the buffer change alone does not help main

Before shipping PR #193, its exact code ran on the iPhone against current
main's JavaScript. Both builds used the R7 native binary with the light host
disabled and carried the same diagnostics. Each got three alternated,
unprofiled `fixed-cold` runs on the real feed (V2, plus V1-S1).

| Build | Missed refreshes per run | Longest callback gap |
| --- | --- | --- |
| main (per-handoff 3 s / 8 s buffer) | 1, 1, 5 | 33.6, 39.7, 59.9 ms |
| main + fixed 8 s buffer (PR #193) | 2 (V1-S1), 3, 2, 7 | 43.3, 65.0, 42.1, 92.9 ms |

The PR build did worse in every alternated pair. The earlier improvement
(R13: 3, 2, 3 missed refreshes down to 0, 0, 0) was measured on the working
tree, which also carries the uncommitted Home work: the fast-coast hold and
the stepped, hysteretic prepared window keep most player creation out of
motion. Without that work, main creates prepared players while the reader
scrolls, and giving each an 8 s buffer target instead of 3 s adds more
loading during motion. So the buffer change is kept out of the release and
reverted on the PR branch. It should ship together with the Home work it
depends on, or be replaced by a buffer target that never changes and stays at
3 s (untested). The sound fix does not depend on either and ships alone.

### Shipped 2026-09-23

PR #193 merged as 6386f3e1: the reel-sound fix plus the OTA target record,
with the fixed feed buffer reverted. Quality and the production release
passed on main. `scripts/publish-ota.mjs` matched both fingerprints (iOS
0.1.5 (54) at 835877cf, Android 0.1.5 (73) at 2d4421b0) and published iOS
group c05ed45f and Android group cacc4d16. Fetched as a phone would, all 91
iOS and 99 Android files matched their sha256. The owner's App Store iPhone
build then reported "Version 0.1.5 (54) · update c05ed45f". Artifacts and
source maps are in `releases/ota/6386f3e1/`. The buffer change and the rest
of the Home work stayed out of that release; they follow below.

### September 23: the release candidate

The candidate is main at 6386f3e1 plus the Home work, the set-once buffer
target and the two Explore fixes from the `explore-autoplay` worktree (the
first visit starts a video; a filter switch opens at the top). Its
JavaScript ran against main's, alternated and unprofiled, on the real For
You feed. The iPhone builds (Q0 main, Q1 candidate) use the R7 native binary
with the light host absent from their JavaScript, as on the store binary,
and add only the probe start. The S24 builds (AQ0, AQ1b) are A9's `.dev`
APK with the bundle swapped; that app's update check fails, so it always
runs the bundle it ships with.

| Measure | main | candidate |
| --- | --- | --- |
| iPhone, six slow drags onto new cards (`fixed-cold`): missed refreshes per run | 2, 2, 2, 4 | 0, 0, 0, 0 |
| iPhone, same runs: longest callback gap | 43.5, 53.1, 58.5, 48.5 ms | 26.5, 31.3, 26.0, 26.7 ms |
| iPhone, three half-screen rocks (`fixed-warm`): missed refreshes per run | 0, 0 | 0, 0 |
| S24, the same six drags: busy stalls per run | 30, 21, 21, 34 | 22, 24, 20 |
| S24, time lost per run | 491, 358, 233, 399 ms | 325, 308, 233 ms |
| S24, longest stall | 125, 133, 58, 42 ms | 67, 58, 33 ms |

The iPhone sets do not overlap. On the S24 the candidate sits inside main's
spread, with no stall over 67 ms; as before, Android's stalls are render
cost. Two earlier S24 candidate runs (AB-C1, AB-C2) are excluded: that
APK still carried the iPhone-only probe start, which threw five seconds
after Home mounted. AQ1b is the same JavaScript without it.

Explore, checked by a runner part (`explore-first-visit`: cold launch onto
Home, open Explore, then All → Free → All) and screenshot differences
(`frame_motion.py`): on main the first visit showed only posters and All
came back mid-feed on posters, on the iPhone; on the candidate the top
video played on the first visit and after the switch, back at the top of
All, on the iPhone and, for the first visit, on the S24.
