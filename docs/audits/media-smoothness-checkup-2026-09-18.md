# Media smoothness check-up — 2026-09-18 (night)

Owner's question: where, in the start, middle or end of each media interaction, does anything stutter, drop frames or otherwise stand in the way. Measured on both phones, each scenario run twice.

Scope: the working tree on `main` at `21c9aed2` with the uncommitted hand-back change (see `docs/plans/viewer-transition-smoothness-2026-09-18.md`, "Second pass"), against production data.

## How it was measured

- **Samsung S24 Ultra (120 Hz), `com.magicbooklet.mobile.dev` release build.** Perfetto traces with SurfaceFlinger FrameTimeline, atrace and logcat recorded in the trace. A temporary build logged a marker at every zoom phase (take-off, landing, hand-off fade, close, return), so each late frame is placed in a section. A gap between two presented frames counts only if the UI thread or RenderThread was busy through it. Idle stretches, when nothing needed drawing, are not stutter. The markers were removed afterwards, and the clean build (sha256 `962d58aa…`) is back on the phone.
- **iPhone 16e (60 Hz), `com.athuls.magicbooklet.zoom` release build.** Instruments *Animation Hitches* attached to the app, driven by `testSmoothnessCheckup` in `.claude/tools/reelprobe` in short segments. Taps go through SpringBoard's coordinates. XCUITest still snapshots the foreground app once before each tap to check for alerts, so a little automation load remains just before each touch.
- **Delivery.** Every media URL in the live feed was fetched twice from the Mac (same network as the phones), with CDN headers and timings recorded. The video renditions were probed with ffprobe.

Evidence, per-run summaries and the scripts: `/Users/athuls/UGC copy/archive/ugc-app-audits/media-smoothness-checkup-2026-09-18/`.

## Where it stutters

"Late frame" means a frame that reached the screen at least one refresh late: 16.7 ms or more at 120 Hz, 33 ms or more at 60 Hz. Ranges cover all runs.

### Android (S24)

| Section | Result | Cause (traced) |
| --- | --- | --- |
| Open, start (tap → take-off 49–89 ms) | 0–3 late frames, 17–42 ms | The flight layer's video view: expo-video inflates a full Media3 `PlayerView`, control bar included, 5–24 ms on the UI thread, plus the layer's mount |
| Open, middle (flight, 215 ms) | Clean: 25–26 frames; one 17 ms late frame in 3 of 13 opens, none in the rest | — |
| Open, end (landing → reel uncovered) | Home video: the carried video freezes 25–67 ms. Image opens: the hand-off fade stutters, 2–4 late frames of 17–50 ms, in 4 of 5 opens | The reel's first mount at landing: UI frames of 32–52 ms (Fabric CREATE ~25 ms plus layout/draw ~15 ms), and mounts landing on the fade's first frames |
| In the reel: video playing | 0–9 video frames per 11 s arrive a frame late (66–75 ms apart instead of 33) | Each video frame redraws the whole window (TextureView): RenderThread 12–14 ms median, 21–22 ms p90, rail icons and shadowed text included |
| In the reel: swipes between video posts | 7–15 late frames per swipe; one 108 ms stall after a swipe | The same per-frame cost: the slide runs at ~40–60 fps instead of 120 |
| Close, start | Back → take-off 2–12 ms; first motion on screen 40–60 ms later | — |
| Close, middle (200 ms) | 0–1 late frame | — |
| Close, end: video hand-back | One late frame of 17–50 ms, every time | The tile's new video view inflates a `PlayerView` (15–44 ms) as it takes the player back |
| Close, end: image | Clean | — |
| Feed flings (Home, Explore) | 0–3 single late frames per fling, 17–50 ms | Cell recycling (REMOVE 14–19 ms), TextureView create/destroy waits (`postAndWait` 15–20 ms), tiles' video views |
| Video loops | Seamless (ExoPlayer repeat) | — |

Also: React Native's event dispatcher re-arms a frame callback on every vsync while the app is in the foreground (`BatchEventDispatchedListeners`), about 0.3 ms per frame. Minor.

### iOS (iPhone 16e)

| Section | Result | Cause |
| --- | --- | --- |
| Open, start | 0–1 dropped frame as the motion starts | A 15–23 ms commit (the flight's picture and chrome) |
| Open, middle | 60 fps. Renders take 7–12 ms with 19–29 offscreen passes per frame | Rounded clip, chrome and shadows in the window |
| Open, end (hand-off) | Explore image: 1–3 hitches of 17–33 ms in all 4 opens. Home video: a 50 ms hitch in 2 of 3 opens | The reel's mount: commits of 17–62 ms, main thread busy 33–60 ms |
| First swipe in the reel (one run) | 4 dropped frames | Neighbour slides mounting (42 ms main-thread block) |
| Later swipes | 0–1 hitch | — |
| Video playing | A **50–70 ms freeze at every loop** (at 3.5, 6.5 and 9.6 s on the 3 s clip) | expo-video iOS loops by seeking to zero on end (`VideoPlayer.onPlayedToEnd`), not gaplessly |
| Close | Home video ×3 and Explore video ×1: no hitches. Explore image ×4: 0–3 hitches of 17 ms | — |
| Feed flings (Home ×8, Explore ×6) | No hitches | Main-thread work (37–63 ms) lands only once a fling has stopped |
| Idle Explore grid | No hitches, but the render server takes 16–18 ms on every other frame (15 offscreen passes) | Each tile clips its image, playing video and badge to a rounded rect, so the playing video re-renders an offscreen pass at 30 fps |

Video is composited by the system on iOS, so it keeps moving through main-thread stalls. On Android the TextureView cannot, so the same stall freezes it.

## Delivery (CDN, files, API)

- **Images: the display-size version was never served. Fixed in this pass.** `loadPostMediaItemsMap` (`src/lib/post-media.ts`) never selected `display_storage_path`, so every API returned `displayUrl: null`. The mobile viewer therefore downloaded originals, although 13 of 15 public image rows have a 1440 px WebP. On the six sampled images: 6.25 MB of originals against 0.72 MB of display versions (88% less). "women" (1536×2752) is 2,844 KB against 149 KB. The viewer keeps the tile's 720 px picture up until the full image paints, so a slow original leaves a soft picture at the end of the open.
- **Videos: in good shape.** H.264 Main, at most 720p, 30 fps, 0.2–1.5 Mbps, `moov` before `mdat` (faststart), 2 s keyframes, 8 s teasers for long clips.
- **CDN:** Cloudflare, Chennai (MAA) edge, `cache-control: public, max-age=86400`, `cf-cache-status: HIT`. The first fetch of an object took 300–490 ms to first byte even on a HIT; repeats took 100–250 ms.
- **API:** Vercel `bom1` (Mumbai). Feed 0.5–0.9 s warm (1.5 s cold), a post 0.2–0.3 s. It is uncached (`private, no-store`). The reel shows its refetch spinner for that long.

## Changes made

- 2026-09-19: `ugc-mobile/lib/zoom-underlay.ts`, `app/(tabs)/_layout.tsx`, `components/media-zoom.tsx` — the tab screen under an open reel is no longer drawn on Android (see "Where our 42 texture draws came from" below). RenderThread per video frame 12.8 → 7.7–8.3 ms on the S24.
- `src/lib/post-media.ts` selects `display_storage_path`, shed first on an older database the same way the other media columns are. Tested in `src/__tests__/post-media.test.ts`: the display URL is served, and an older schema still loads. The test fails without the fix. A local server against the production database returned the display URL for "women", where production returns null. Web suite: 794 files / 5,785 tests; the tests and scripts typechecks pass. The app typecheck passes apart from a stale generated `.next/types/validator.ts` (dated Sep 14), which predates this change. The fix goes live with a web deploy; the apps already read `displayUrl`.

## Tried and not kept (measured on the S24 kungfu-cats reel)

- Dropping the permanent `renderToHardwareTextureAndroid` layer on the reel's video wrapper (`needsOffscreenAlphaCompositing` already keeps the fade correct). The median fell 13.8 → 12.3 ms with no change in late frames. Kept as is.
- Caching the rail and caption as hardware layers. In steady playback the p90 fell from 21–22 to 15 ms, but each new layer costs a 5–9 ms GPU allocation when a slide mounts. That put two 75 ms stalls after an open, into exactly the transitions being fixed. Rejected.

## Recommendations, in order

1. **Deploy the display-image fix** (web only).
2. **Android reel video through a SurfaceView once the reel is at rest** (`surfaceType` on expo-video's `VideoView`), keeping TextureView for zoom flights and the hand-back. Frames would go straight to SurfaceFlinger: no whole-window redraw per video frame, no freezes from UI-thread stalls, and smooth swipes. It needs its own hand-off design and device testing.
3. **Android: a light `PlayerView` layout without the control bar.** A config plugin can write the app's own `texture_player_view.xml`/`surface_player_view.xml` with a stripped `player_layout_id`. That removes 5–44 ms from every video view creation (open start, close landing, feed activations). First check that expo-video never calls controller methods (`checkStateNotNull`). This is a native change and needs a store build.
4. **iOS: gapless loops.** A patch to expo-video (`actionAtItemEnd = .none` plus a seek while playing, or `AVPlayerLooper`). This is a native change and needs a store build.
5. **Both platforms: lighten the reel's first mount at landing.** `IconShadow` renders every rail icon twice; defer what isn't visible until the reel settles. This is the main "end of open" cost.
6. **iOS grid:** keep playing video out of rounded `overflow: hidden` containers that also hold badges, to cut the offscreen passes.

## How Instagram does it, measured on the same phones (2026-09-19, 23:40–00:25)

Owner's follow-up: the remaining minor drops — how does Instagram avoid them, native components? Instagram 447.0.0.0.51 was traced on the S24 with the same Perfetto config, gestures and rules as our runs (`scripts/instagram/ig_drive.py`), and Instagram 445.0.0 on the iPhone 16e through a system-wide Instruments recording (Display + Hitches + Points of Interest, all processes), driven by the probe's `ig-*` parts. A store app cannot be attached to, but the system-wide hitch table names the process, and the probe's marks are signposts on the trace clock. Summaries: `summaries/instagram-*.txt`.

### What it is built from

- Native throughout: no React Native on any media surface (the APK's only RN routes are ad-billing screens). View classes are obfuscated (`X.2dP`), ids remain (`clips_viewer_view_pager`: the reel is a ViewPager).
- Its own pipeline: `libmediamerged.so`, `libstreamingmerged.so`, `libsurfside_media_decode_swapchain.so` (decode straight into a swapchain of surfaces), `libhardwarebuffer_converter.so`, and `layouts.bin.xz` (precompiled layouts, no XML inflate).
- **Android video is not a SurfaceView.** With a reel playing, SurfaceFlinger holds only Instagram's window layer (no `SurfaceView[...]`), and FrameTimeline shows every video frame presented as a window frame. Instagram draws the video inside its window through a SurfaceTexture, the same mechanism as expo-video's TextureView. The difference is what else is in the frame.

### S24, same gestures

| | Instagram | Ours (last night) |
| --- | --- | --- |
| Reel playing: RenderThread per frame | 4.2 ms median / 4.8 p90. Drawing 2.8, syncFrameState 1.0, prepareTree 0.24; about 4 texture ops and 8 rects per frame | 13.9 median / 22.5 p90. Drawing 11.0, syncFrameState 3.8, prepareTree 2.6; about 42 texture ops and 42 rounded rects per frame |
| Reel swipe | the page moves at 120 Hz (RT 2.2–2.7 ms), then a **99–116 ms UI-thread stall in the frame where the snap ends**, every swipe (its own code, CPU-bound), and the new reel's first 1.3 s plays unevenly (42–67 ms between frames) | 7–15 late frames during the motion; one 108 ms stall |
| Explore tile open / back | open: a 48 ms `RV OnLayout` frame and a 108 ms gap; back: 43 ms layout, a 67 ms gap. No zoom: it pushes a feed page and restarts the video | open end 25–67 ms freeze / 2–4 late frames; close end 17–50 ms |
| Home flings (4 down, 4 up) | 25–28 late frames; `postAndWait` 14–48 ms as tiles' TextureViews come and go; RT p90 9.5–9.9 ms | 0–3 late frames per fling |
| Explore flings | 6–7 late frames; RT p90 7 ms | 0–3 per fling |
| Heaviest frame seen | a blurred "Suggested for you" card page: 15.7 ms per frame at 25 fps | — |

### iPhone 16e

| | Instagram | Ours (last night) |
| --- | --- | --- |
| Reel playing (30 s on one reel; the clip was ~25 fps) | 8 hitches of 17 ms; 44 intervals of 4 vsyncs or more. A 24/25 fps clip alternates 2 and 3 vsyncs by nature, so only the 4+ count is a stall | 30 fps clip steady; a 50–70 ms freeze at each loop |
| Reel swipes | 1–2 hitches of 17 ms per swipe, at the settle | first swipe 4 dropped frames, later swipes 0–1 |
| Explore open / back | no hitches (a pushed page, video at a steady 30 fps from its first frame) | image opens: 1–3 hitches at the hand-off |
| Explore flings | 1–3 hitches of 17 ms per 3 flings | none |
| Home flings | 4 hitches in 4 flings down, 0 in 4 up | none |

Instagram's loop point could not be isolated on the iPhone (clip length unknown, 25 fps content). The Android 30 s loop run did not happen: the S24 dropped off USB at 00:10.

### What that means

1. In transitions and flings Instagram is not smoother than us on these phones. Its reel swipe holds the last frame of the snap for ~100 ms every time; its Explore open lays out a RecyclerView for 43–48 ms; on the iPhone it drops the same one or two frames per swipe. Its opens have no zoom and no player hand-off: a page is pushed and the video restarts, so there is nothing to stutter. What we do at the end of an open is harder than what Instagram does.
2. Steady playback is where it wins on Android: 4 ms per frame against our 14. Not from SurfaceView, from an almost empty draw list around the video and a shallow tree. Everything that isn't moving is already a few flat bitmaps.
3. Its video start is not instant either: after a swipe or open the first ~1.3 s plays unevenly on the S24 while it buffers, hidden behind the poster frame.

### Where our 42 texture draws came from, and the change made (2026-09-19, 01:00–01:30)

The S24 came back, so both apps' reel screens were dumped (`dumpsys activity top`, in `summaries/*-reel-view-tree-2026-09-19.txt`). Instagram's reel: 270 views, 144 visible, 14 image views, 8 text views, its components hosted by Litho (`ComponentHost`, which draws text and drawables without child views). Ours: 1,320 views, 1,249 visible, 433 RN view groups, 97 SVG icons with 127 paths and 111 circles, 40 images.

Half of ours were not the reel at all. On Android the viewer is presented as a `transparentModal` (`app/_layout.tsx`), so the tab screen it opened from stays attached and visible underneath: the Explore grid's 22 images, 27 SVG icons and its text were drawn under every video frame. Instagram's 30 s reel run also confirmed its Android loops are seamless (no gap over 45 ms, 0 late frames, UI thread at most 4.9 ms).

**Change:** `lib/zoom-underlay.ts` holds a Reanimated mutable; the tab layout wraps its `Tabs` in an animated view whose opacity follows it, so the renderer skips the subtree (alpha 0, no relayout). The stage sets it once the reel is uncovered (`finishOpen`) and clears it with the close flight's own values in `startZoomFlight`, in `dismiss`, in `leave` and on unmount. Android only: iOS pushes a card and keeps its own pop gesture. Test: `__tests__/zoom-underlay.test.ts`; mobile suite 239 files / 2,384 tests and typecheck pass.

**Measured on the kungfu-cats reel, same window rule, same night** (`scripts/android/loopcompare.py`, summaries in `summaries/android-underlay-*.txt`):

| Per video frame, S24 | Clean build | Grid hidden (2 runs) |
| --- | --- | --- |
| RenderThread median / p90 / max | 12.8 / 19.5 / 29.4 ms | 8.3 / 15.1 / 26.0 and 7.7 / 12.1 / 46.7 ms |
| Drawing (GPU submit) | 10.0 ms | 5.7 ms |
| Texture draws / circles / rects / text runs | 34 / 32 / 20 / 12 | 12 / 6 / 12 / 6 |
| syncFrameState (tree walk) | 3.5 ms | 3.3 ms — the hidden subtree is still walked |

The close was checked frame by frame: the grid is drawn again from the close's first moving frame (+164 ms after Back, 44 ops), never later; the screen after a Home close and an Explore close shows the feed and grid. The open's end is unchanged (its 70–94 ms mount frames are the reel's own).

Still to shrink, in order: the tree walk (3.3 ms: the hidden subtree could be detached with `display: 'none'` at the cost of a relayout at close), and the reel's own 12 textures and 6 circles (the rail's SVG icons and their shadows as one bitmap each).

### What to take from it

- The Android reel can stay on TextureView if the per-frame draw list shrinks to Instagram's size. The covered-grid change above takes it from 42 to 12 texture draws. Aim for about 10 texture ops per frame: the rail as one cached bitmap per icon (shadow included, instead of two draws), the caption and chips as layers. The rejected experiment allocated those layers while a slide mounted, inside the transition; allocate them once the reel has settled and keep them, and measure by TextureOp count per frame (`rtbreak.py`). This is JS-side and can ship over the air. SurfaceView remains the alternative; Instagram shows it isn't required for 120 Hz swipes.
- The iOS loop freeze is still ours to fix (expo-video's seek-to-zero); Instagram's playback carried its own 25 fps judder, and no loop freeze could be attributed either way.
- The reel's first mount at landing stays the main "end of open" cost on both phones; Instagram avoids it by pushing a page that is laid out before it is shown.
