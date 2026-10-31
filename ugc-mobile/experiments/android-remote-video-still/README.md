# Android remote video still

Status: **built into an Android dev client and run on the Pixel 9a emulator (2026-10-31); waiting for the next Android store build (the 0.1.9 plan). Not yet run in a release build or on a phone.**

The patch is deliberately outside `patches/`, so `postinstall` does not apply it: `@expo/fingerprint` hashes `patches/` for both platforms and hashes the patched `node_modules/expo-video/android`, and either would stop JavaScript-only updates reaching the binaries already out. It moves into `patches/` in the commit the next Android store build is cut from ("Graduating" below), and `__tests__/android-remote-video-still.test.ts` fails the release bump that leaves it behind.

Unlike the other parked patches, the JavaScript that uses it is on `main` already: `lib/video-frame.ts` reads stills on Android only where the binary has the function this patch adds (`generateThumbnailFromUrlAsync` on the `ExpoVideo` module), and finds that out when it is first used. On Android builds without it every clip card keeps a plain play mark.

## What it fixes

A recipe's video reference on a post's Details page and a run's later video outputs had no picture on Android, only a play mark, and a creation's video input drew a document icon on both platforms. React Native has no `<video preload="metadata">` to draw a clip's first frame, and #605 drew one on iPhone with expo-video's `generateThumbnailsAsync` from a player that is never shown. It kept Android off because of how expo-video 55 reads a still there:

```kotlin
AsyncFunction("generateThumbnailsAsync") Coroutine { ref: VideoPlayer, times: List<Duration>, options: VideoThumbnailOptions? ->
  return@Coroutine ref.toMetadataRetriever().safeUse { … }
}
```

`toMetadataRetriever()` calls `MediaMetadataRetriever.setDataSource(url, headers)`, which opens the clip's link and blocks until the clip's header has arrived. Every Expo module's async calls start on one thread, `expo.modules.AsyncFunctionQueue` (`expo-modules-core`'s `AppContext.kt`), and a `Coroutine` body runs there until it first suspends; this one blocks before it ever does. On a slow or stalled link that held up every other module's async call for as long as the open took: SecureStore's reads of the Supabase session, haptics, the clipboard, the viewer's `replaceAsync`. A JavaScript deadline cannot free a native thread.

## What it changes

Two things in `VideoModule.kt`, nothing else:

- **A read with no player**, `generateThumbnailFromUrlAsync(url, time, options)` on the module. Its body leaves the shared thread first (`withContext(Dispatchers.IO)`), then makes a `MediaMetadataRetriever`, opens the link, reads the frame with expo-video's own `generateThumbnailAtTime` (the same scaling and the same `VideoThumbnail` as the stock read, so expo-image draws it as it draws iPhone's), and releases the retriever in a `finally`, with `release()` because the retriever is `AutoCloseable` only from API 29. No player is made: expo-video prepares a new ExoPlayer at once, and its progressive loader reads about 1 MiB of the clip before it first consults the load control, so a hidden player cost a megabyte per still on top of the still's own reads, and a decoder beside the reel's.
- **The stock read's open and close move onto the IO dispatcher too**, so any caller of `generateThumbnailsAsync` is safe on Android. The app no longer calls it there.

Neither can be cancelled once started: `MediaMetadataRetriever` gives no way to interrupt `setDataSource`. So on Android `lib/video-frame.ts` waits for the native read itself, up to `PLAYERLESS_READ_DEADLINE_MS` (60 s), before it starts the next one, however early its card stops waiting (the page leaving); a card that asks again for a clip being read joins that read; and a card takes a still that comes late, up to the same 60 s, where iPhone's player read gives up at 15 s. At most one native read is under way at a time, and one more for each that ran past 60 s.

### How it gets compiled

expo-video is compiled from source here for two reasons already on `main`: `package.json` lists it under `expo.autolinking.android.buildFromSource`, and `patches/expo-video+55.0.21+002+android-light-player-view.patch` removes the `publication` entry from its `expo-module.config.json`. This patch adds neither.

`+002+` also changes `VideoModule.kt`, so this patch is cut against the file it leaves (`index 0987c7c..`), and the guard test pins that chain. It carries the number `+007+` because `+005+` and `+006+` are the other parked expo-video patches (`experiments/android-video-view-touch-end/`, `experiments/android-fullscreen-waiting-clip/`); the three change different files.

To check that a build carries it, look in the APK: `unzip -p <apk> 'classes*.dex' | LC_ALL=C grep -a -c generateThumbnailFromUrlAsync` is 1 with the patch and 0 without, and the app's own check is `requireOptionalNativeModule('ExpoVideo').generateThumbnailFromUrlAsync`.

## What has been checked

On the Pixel 9a emulator (API 36), 2026-10-31, with one JavaScript bundle (this branch, production data) on two dev clients: the one that was on the emulator (0.1.7, no `generateThumbnailFromUrlAsync` in its dex) and one built from this branch with the patch applied by hand (0.1.8, arm64, debug; the function is in its dex). A throwaway probe screen timed a `SecureStore.getItemAsync` and a `performAndroidHapticsAsync` round trip 1.5, 5 and 10 s after starting a still read, against a clip server on the Mac that sent no byte for 20 s (`hold20`) or served the clip at 20 KB/s (`slow20000`). The server's log shows each read's first request arriving at once and held, so every sample was sent while the retriever was inside `setDataSource`.

| | SecureStore / haptic round trip, sent 1.5 / 5 / 10 s into the read |
|---|---|
| Without the patch, stock read from a player, link held 20 s | 40.2 / 36.7 / 31.7 s, all released together when the open returned (a call from another screen waited 40 s too) |
| With the patch, the new read with no player, link held 20 s | 1 / 1 / 1 ms (haptic 0 ms at 10 s) |
| With the patch, the stock read from a player, link held 20 s | 1 / 1 / 1 ms |
| With the patch, the new read, link at 20 KB/s | 1 / 1 / 1 ms |

All four reads went on to give the clip's 405×720 still at 0.1 s, which expo-image drew. The new read made no request from ExoPlayer at all; the stock one's player retried the held link every 10 s.

On the real page (the post a recipe video reference was first reported on, its Details page through the card's Unlocked chip), with the patched dev client: at full speed the still was read in 0.9 s and drawn under the play mark. With the emulator's network shaped to GPRS, UMTS, or HSDPA speed with UMTS latency, nothing on the page loaded quickly (the reference pictures stayed blank too) and the still missed the 15 s deadline the app then gave Android reads too, leaving the plain play mark, while a SecureStore read and a haptic sent every second through the read took 0 to 25 ms. That run is why Android now waits up to 60 s, and why a read called off is not opened a second time beside itself. Evidence, the probe and the clip server: `archive/android-video-stills-2026-10-31/` at the workspace level.

Also: the patch round-trips (`patch-package --patch-dir` applies it on top of the four shipped expo-video patches and `--reverse` puts back the blob `+002+` leaves, `0987c7c`), a plain `patch-package` run stays content with it applied, and the guard test fails for a release bump that leaves it parked, for the patch in both places, for it shipped ahead of the parked `+005+`/`+006+`, for an open moved ahead of the switch to the IO dispatcher, and for the stock read's open left on the shared thread.

**What a still costs in data.** The review asked whether the platform cache under the retriever reads most of a clip for one still. Counted on a clip server that paces a 15.4 MB clip (720×1280, 6 Mbit/s): at 3 MB/s a still took 0.6 to 1 MB with the clip's header first and 1.5 MB with it last (the retriever reads the start, the header range at the end, then the start again for the frame); at 30 MB/s, 1.5 MB and about 5 MB (the server sends in 1.5 MB steps there, so those are coarse). The stock read from a player took the same, plus ExoPlayer's own 1.2 to 6 MB. Opening the link with the cache's own request headers (`x-cache-config`, `x-disconnect-at-highwatermark`) changed nothing measurable, so the patch does not carry them. A clip saved with its header at the end is the expensive case.

**Not done.** No release build and no phone. The emulator's network shaping is crude: on a phone a 3G-class link may well bring the still in under the deadline. The patch is Kotlin, but the JavaScript beside it changes iPhone too, by the next update: a creation's video inputs and a run's later video outputs read stills there as well, and every clip card has the one play mark (44pt, the video accent when there is no picture under it).

## Apply and reverse

After `npm ci` (whose `postinstall` applies the shipped patches):

```sh
./node_modules/.bin/patch-package --patch-dir experiments/android-remote-video-still/patches
```

Reverse with `--reverse`. `patch-package --reverse` ignores `--dry-run` and really reverses, so check what is applied by grepping `node_modules/expo-video/android/src/main/java/expo/modules/video/VideoModule.kt` for `generateThumbnailFromUrlAsync`. Reverse it before running `scripts/verify-ota-target.mjs` or publishing an update from the same tree. Applying and reversing it leaves `node_modules/expo-video/.patch-package.json` as it was.

## Graduating

In the release bump that the next Android store build is cut from:

1. Graduate `experiments/android-video-view-touch-end/` (`+005+`) and `experiments/android-fullscreen-waiting-clip/` (`+006+`) in the same commit or before, as their READMEs say: patch-package applies a package's patches in the order of their numbers and refuses a tree whose applied patches are not the first of that order, and this guard fails a `+007+` shipped ahead of a lower-numbered parked one.
2. `git mv experiments/android-remote-video-still/patches/expo-video+55.0.21+007+android-remote-video-still.patch patches/` and put a "Graduated on" line at the top of this file.
3. If iOS is not rebuilt in the same release, add the file to `ios.setAside` in `ota-targets.json`: the patch is Kotlin only, but any file in `patches/` moves the iOS fingerprint.
4. When that binary ships, record its Android fingerprint in `ota-targets.json` as usual. Nothing in the JavaScript changes: it finds the function by itself.

A release that ships no Android binary can repin the version in the guard test instead. Drop the patch when the app moves to an expo-video that carries the change (see "Upstream").

## Before promotion

- A release build with the patch: the dex has `generateThumbnailFromUrlAsync` (R8 keeps expo-modules' function names: they are strings in the module definition).
- On a phone with that build: a post whose recipe has a video reference shows the clip's still on its Details page, and so does an owner's creation with a video input; a press opens the clip; the still is there again after leaving and coming back. With the phone's network made slow (a throttled hotspot), haptics on the page's buttons still answer at once while the stills load.

## Upstream

`VideoModule.kt` on expo's `main` still opens the retriever in the async function's body. No report has been written for expo/expo.
