# Reel slide view cut

Status: step 1 was measured on 2026-09-24 and not shipped; the step 1 result below gives the numbers. Step 2 shipped as #210 (`19881e5f`) on 2026-09-25, after its S24 A/B and Save check: over the air to Android 0.1.6 (74) that day, and in both 0.1.7 store builds (Android 75 is in production; iOS 57 is in App Review). Step 3 is next, when the owner asks for it.

Scope: `ugc-mobile/app/viewer.tsx`, `components/reel-chrome.tsx` and `components/reel-icon.tsx`. Every change is JS, so each step can ship over the air to the current store build, 0.1.7.

Measure each step on the S24 first. iOS runs the same code and is checked in the batched iPhone pass.

## Why

Every reel swipe pays for the views of one slide, and nearly every cost scales with that count. Measured on the S24 on 2026-09-24, over alternated runs of one native build (#208 records the method):

- **Mid-swipe mount.** As the scroll moves, the list builds the slide beyond the one being landed on. That is about 140 views and 25–40 ms on the UI thread, the same thread that moves the list. As a result, 12–14% of display refreshes are missed during the drag and snap.
- **Postponing does not help.** Building that slide only after the reel settles halves the misses to 5.5%, but the landed video then freezes for 42–92 ms on most swipes. The whole slide still has to be built.
- **The walk at rest.** Since #208 stopped hiding the neighbours' chrome, the RenderThread walks 667 views for every frame of a playing video. That comes to a median of 8.9 ms of each frame's 33 ms. It costs battery, not smoothness.

## Where the views are

This is the S24 view dump of a reel on main after #208. Four slides were mounted, at 155–178 views each.

| Part of one slide | Views | What they are |
| --- | --- | --- |
| Details page (the pager's second page) | 57–73 | `PostDetailsPage` is mounted for every post with `details`. The pager keeps one page either side of the current one, so a neighbour mounts it too, although its pager cannot scroll (`scrollEnabled={active}`). |
| Rail, six buttons | ~51 | Each button is a `Pressable`, then two `Animated.View` scale wrappers, then the icon raster through `expo-image`, plus a count label. Only the save button animates. On Android, `expo-image` is four native views: a wrapper, a `FrameLayout`, and two image views kept for crossfades. |
| Rail avatar and follow pill | ~10 | A network avatar, rightly drawn through `expo-image`. |
| Caption and creator row | ~11 | |
| Media page (poster, backdrop, letterbox bands) | 17–20 | Three `expo-image` instances. |
| Player host (prepared slides only) | 11 | The light `PlayerView` from the store build. |

## Steps

Each step is A/B-tested against the step before it. A step is kept only if motion or landing improves and pickup is no worse.

1. **Mount the details page only for the slide being read.**
   - Neighbours give their pager a one-page window, so only the page they would open on is mounted.
   - The slide on screen mounts its details page in the lower-priority render after landing (`deferredVideoIndex`). That page sits off screen until a sideways swipe, which nobody makes in the first few hundred ms.
   - It mounts at once in two cases: when the reel opens or restores onto the details page, and when the Details button is pressed first.
   - **Expected:** 57–73 fewer views in the slide built mid-swipe and in each resting neighbour. The walk at rest drops by about 190.
   - **Result, 2026-09-24:** not kept. It was A/B-tested against main (after #208), three swipe runs and one rest run per build.
     - The slide built mid-swipe fell from 108–149 views to 70–91.
     - But the landed slide's details page, 54–75 views, then mounted after landing, in the settled render. Busy stalls of 50 ms after landing rose from 1 to 6 of 15 swipes.
     - Pickup (median 40 ms against 32) and missed refreshes in motion (12% against 10%) were no better, within run-to-run noise.
     - At rest it saved 0.3 ms per frame.
     - Like staging, it moved the work rather than removing it. The patch is `ab/DP1-pager-window.patch` in the archive.
   - **What would remove the work:** build the details page only when the reader heads for it, meaning a sideways drag or the Details button, with a light shell first. That changes how the sideways swipe feels, since the page would fill in as it slides in.
   - **The owner's call, 2026-09-25:** keep the details page ready in advance. So the remaining lever for it is a lighter page, not later building.
2. **Leaner rail buttons.**
   - Draw the icon rasters with React Native's `Image`, which is one native view, instead of `expo-image`'s four. All 13 rasters are local `require()` PNGs, so nothing needs its caching or crossfade. Use `fadeDuration={0}`; Android fades images in over 300 ms by default.
   - Keep the scale wrapper only on the save button. Its tap pop and double-tap pop combine into one wrapper (`Animated.multiply`), plus its halo. The other five buttons get none.
   - **Expected:** about 30 fewer views per slide.
   - **Visual check:** the rail must be pixel-identical. Screenshots before and after are compared region by region, with `region_diff.py` from the 09-23 audit.
   - **Guard test.** `__tests__/react-native-image-retired.test.ts` keeps React Native's core `Image` retired (Android plan phase 5a: one image pipeline, Glide through expo-image). Step 2 adds one narrow exception, `components/reel-icon.tsx` with bundled `require()` PNGs only, and a test that the file takes no URL. Fresco starts at launch either way (`FrescoModule` is `needsEagerInit`), so the cost is these icons' bitmaps in its memory cache. The owner approved the exception on 2026-09-25.
   - **Built 2026-09-25 (RL1).** It is pixel-checked on the Pixel 9a emulator, on the @batman reel with the rail over a playing video, comparing two shots per build:
     - The opaque Remix circle is identical (difference 0).
     - The heart, comment and Details glyphs match within the shot-to-shot noise.
     - Share and more sit about 0.45 px lower, from layout rounding once their wrappers are gone. That is invisible.
     - The save button's pops now go through one `Animated.multiply` transform, which the native driver supports.
     - **S24 A/B, 2026-09-25 ~01:22–01:34.** Main (ND1) against RL1, alternated, three swipe runs and one rest run each. The view dumps now target our activity only.
       - **Views:** 1,128 → 988 in the reel window; walked views 667 → 551 (−17%), the same in every dump.
       - **Missed refreshes in motion:** lower in each alternated pair, 9% → 4%, 23% → 17% and 24% → 16%; 117/674 against 89/731 overall.
       - **Pickup median:** 32 against 32 ms.
       - **Stalls after landing:** 5 × 42 ms against 4 × 42 ms plus one 92 ms. That one was the list dropping a slide (a mount pass removing 116 views) after an unusually long swipe, which is the same work main does.
       - **At rest:** 10.2 against 9.9 ms in one run each, within noise.
       - **Views built mid-swipe per swipe:** ~9 fewer. Fabric creates an expo-image as a single view, so the icon change shows in the native views and the walk, not in the creation count.
     - **Save check, S24, 2026-09-25.** The `.dev` app ran RL1's embedded bundle (the Settings footer shows no update id). It is signed in as the @batman test account, so the checks ran on @batman's own paper-boat post, and no other creator was notified. The rail heart's width was measured frame by frame in screen recordings (`ab/save-check-s24/`):
       - **Unsave tap:** a dip to 0.96, against the spec's 0.94.
       - **Save tap:** 0.88, then 1.12 at the peak, then 1.0 over about 230 ms. The spec is 0.88 → 1.1 → 1.0.
       - **Double-tap on the picture** (the post already saved, so nothing is saved): the external pop reached 1.16 and settled within about 210 ms. The spec is 1.13 over 230 ms.
       - Both pops run through the one `Animated.multiply` transform on the native driver, with no JS or native-animated errors in logcat. The width measure reads a few percent high, from the stroke's antialiasing.
3. **Re-apply staging.**
   - This is `ab/RS1-staging.patch` in the 09-24 archive: slides two away from the settled one mount as posters in a five-slide window.
   - A promotion after landing then builds the ~35-view chrome instead of ~110 views, so it should fit between video frames.
   - **Expected:** about 5% of refreshes missed in motion (RS1 measured 5.5%), without RS1's landing freezes.
4. **Later, only if still needed.** The poster's three images (merge the backdrop and bands), then the caption's wrapper views.

**If steps 1–3 had held** (step 1 did not, as built):
- A slide goes from about 160 views to about 60.
- A swipe builds only a poster, about 20 views, while it moves.
- The walk at rest drops from 667 to about 350 views.
- The pickup stays at #208's 33 ms.

## Measurement per step

- **Builds.** `build_swap.sh` exports the JS, compiles it with Hermes and swaps it into the same `.dev` release APK, so only the JS differs (about 20 s per build).
- **Runs.** `run_ab.sh` alternates the builds: three swipe runs and one rest run per build, about 11 minutes of the S24, which must be idle on its home screen.
- **Scoring.**
  - `swipephases.py`: pickup (first touch to first 120 Hz frame), refreshes missed in motion, and stalls of 50 ms or more in the 900 ms after landing.
  - `loopcompare.py`: RenderThread time per resting frame.
  - `viewtree_outline.py`: views per slide, from the dump taken while the reel is open.
- **Tests.** The vitest suite and the typecheck. `compiled-screens.test.ts` must keep the viewer compiled, and `reel-icon.test.tsx` changes with step 2.

## Options considered

| Option | Verdict |
| --- | --- |
| Native rail: one custom view drawing the rail's icons and counts | Not now. It needs a store build, and step 2 cuts most of the rail's views over the air. |
| Native vertical pager (ViewPager2), as the 09-19 plan conditionally proposed | Not now. The measured cost is building React views, which a native pager would still do. |
| One shared rail over the list instead of one per slide | No. The rail would stop moving with its post during a swipe, and Instagram and TikTok both move it. |
| Cache the chrome as bitmaps | No. That was a negative result on 2026-09-19: more walk, and the allocations landed in the open. |
| Hide the neighbours' chrome at rest | No. Removed in #208, because showing it again at the first touch slowed the pickup. |

## Risks

- **Details reached before it has mounted.** Covered by mounting at once for the Details button and for restores onto the details page, each with a test.
- **React Native's `Image` on its first draw.** Decoding is asynchronous, so a rail icon could appear a frame after its slide mounts. That is acceptable for off-screen neighbours. Check the landed slide on the device.
- **iOS.** It runs the same code. Neither change is platform-specific, and both are verified in the batched iPhone pass.
- **Hit targets and accessibility labels.** Unchanged, since the `Pressable`s are untouched. The HIG guard tests keep enforcing both.

## Shipping

Ship one PR per kept step, or batch them. Each goes over the air to the current store build, 0.1.7, with `publish-ota.mjs`, as #208 and #210 did.
