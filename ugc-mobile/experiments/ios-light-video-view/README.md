> **Graduated on 2026-09-24** into `patches/expo-video+55.0.21+004+ios-light-video-view.patch` for store build 0.1.6, applied by `postinstall` like every shipped patch; the copy that lived here is gone, so "Apply and reverse" below is history. Measured before it moved, on the iPhone 16e: two Release builds of main `0d570a16`, without (LH0) and with (LH1) this patch, alternated, Time Profiler over four Home drags each way and a reel open (`archive/home-scroll-audit-2026-09-22/device-ab/run_lh.sh`, runner part `light-host`). Per 40 s run: `AVPlayerViewController` on the main thread 22 and 29 ms against 0 and 0; React Native's clip walk 1,013–1,015 ms against 901–907 ms, because the tree it recurses through is shallower; main-thread time outside accessibility (on because XCUITest drives the phone) 2,599–2,637 ms against 2,308–2,344 ms.

# iOS light video host

Before 0.1.6 this patch lived outside `patches/` on purpose: `@expo/fingerprint` hashes `patches/` and the patched `node_modules/expo-video/ios`, so keeping it here keeps JavaScript-only over-the-air updates reaching the binaries already in testers' hands. Graduate it into `patches/expo-video+55.0.21+004+ios-light-video-view.patch` only in the commit a store build is made from, and update `ota-targets.json` when that binary ships.

## What it changes

`VideoView` on iOS wraps an `AVPlayerViewController` even with `nativeControls={false}`. Mounting one loads the controller's whole view hierarchy on the main thread; every window move starts an appearance transition; every safe-area change removes and re-adds its view; and paused frames go to Live Text analysis. The feed mounts and releases these views while the reader scrolls (docs/archive/home-scroll-hitches-2026-09-22.md, Layer 2).

The patch adds `LightVideoView`: an `ExpoView` whose single subview is backed by an `AVPlayerLayer` (Apple's documented `layerClass` pattern). It supports `player`, `contentFit`, `contentPosition` and `onFirstFrameRender`, the last from KVO on `AVPlayerLayer.isReadyForDisplay`, the same signal the stock view reads from the controller. `VideoManager` pauses its player on backgrounding like a stock view's. The module reports `supportsLightweightViews` on iOS too, and the React wrapper picks the light host for `nativeControls={false}` only when that constant is present, so JavaScript carrying this patch still renders the stock view on older binaries. Screens that keep controls, fullscreen or Picture in Picture (creation previews with controls, the lightbox) are unaffected.

## Apply and reverse

After `npm ci` (whose `postinstall` applies the shipped patches):

```sh
npx patch-package --patch-dir experiments/ios-light-video-view/patches
```

Reverse with `--reverse`. Note that `patch-package --reverse` ignores `--dry-run` and really reverses; check what is applied by grepping `node_modules/expo-video/ios/LightVideoView.swift`, never with a "dry" reverse. Reverse it before running `scripts/verify-ota-target.mjs` or publishing an update from the same tree.

## Before promotion

- Native iOS build, simulator and iPhone.
- Feed tiles, the reel and the zoom layer play, draw their first frame (poster lifts), loop, pause on backgrounding and resume.
- The tile-to-reel zoom and the reel-to-tile hand-back still carry the live video.
- Creation previews with controls and the lightbox still show native controls.
- Instruments on the iPhone 16e: Home scroll hitches and `AVPlayerViewController` frames gone from the main thread during scrolls, compared against the same build without the patch.
