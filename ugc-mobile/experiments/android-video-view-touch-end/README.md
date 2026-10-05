# Android video view touch end

Status: **built into the Android dev client and run on the Pixel 9a emulator (2026-10-05); waiting for the next Android store build. Not yet run in a release build or on a phone.**

The patch is deliberately outside `patches/`, so `postinstall` does not apply it: `@expo/fingerprint` hashes `patches/` for both platforms and hashes the patched `node_modules/expo-video/android`, and either would stop JavaScript-only updates reaching the binaries already out. It moves into `patches/` in the commit the next Android store build is cut from ("Graduating" below), and `__tests__/android-video-view-touch-end.test.ts` fails the release bump that leaves it behind.

## What it fixes

With `nativeControls`, expo-video's Android view tells JS of the touches on it itself, from `onInterceptTouchEvent` (`VideoView.kt`). Android calls that hook for every event of a gesture, unless a child has asked its parents not to intercept. Media3's time bar asks exactly that as a touch lands on it (`DefaultTimeBar.startScrubbing`; a press with no drag is enough, and in media3-ui 1.8.0 it is the only class that asks). The view records the request, as any `ViewGroup` does, and Android stops calling its hook for the rest of the gesture. JS is told that the touch began and never that it ended.

Whatever JS view took that touch-down stays React's responder. React asks nothing below a responder about the next touch, so the next press goes to the holder and is lost; only that press's end lets the holder go. What a person sees: scrub a clip, press a button, nothing happens; press again and it works.

The JavaScript fix (#359, `lib/native-touch-owner.ts`) keeps JS views from taking such a touch: the player's view declines the start question and stops it there, so nothing above it is asked. That leaves two things only native code can end:

- **A view that takes the start question in the capture phase is asked before the player's view.** React Native's `ScrollView` does in two cases (`_handleStartShouldSetResponderCapture`): while it counts itself as coasting from a fling, and while the keyboard is up if its `keyboardShouldPersistTaps` is left at the default. Both lose the next press with #359 in place (emulator, below). The app's scroll views above a player all set `handled`, except the result sheet's, which has no field; so in the app as it is, the coasting one is the case to meet.
- **JS's count of touches in progress stays one too high** after each such touch (`trackedTouchCount` in React's responder plugin). On Android nothing reads it today.

## What it changes

One method on `VideoView`:

```kotlin
override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
  parent?.requestDisallowInterceptTouchEvent(disallowIntercept)
}
```

The view passes the request on to the views above and does not record it. Its own hook therefore goes on being called, and JS hears the moves and the end of the touch.

- **Nothing below the view loses anything.** The flag the view no longer sets has one reader in Android (`ViewGroup.dispatchTouchEvent`, deciding whether to call `onInterceptTouchEvent`), and this view's hook always returns false: it reports, it never intercepts.
- **The views above still get the request,** so a scroll view around the player still cannot take a scrub. Dropping the request instead would fix the reporting and break that.
- It is what React Native's own root views do, for the same reason (`ReactRootView` and `ReactSurfaceView` pass the request on without recording it; the Modal's `DialogRootViewGroup` drops it, having nothing above it that scrolls).
- It applies to every `VideoView`, with or without controls. Without controls nothing below the view makes the request.

### How it gets compiled

Expo's Android modules are linked as prebuilt archives, and a patch to the Kotlin of one is ignored without a word. expo-video is compiled from source here for two reasons already on main: `package.json` lists it under `expo.autolinking.android.buildFromSource`, and `patches/expo-video+55.0.21+002+android-light-player-view.patch` removes the `publication` entry from its `expo-module.config.json`. This patch adds neither. It changes the same Kotlin file as that one and is cut on top of it (its `index 043ce01..` line starts from the blob that patch makes), which is why its name carries the next number, `+005+`: patch-package applies a package's patches in that order.

To check that a build really carries it, look in the APK, not the build log: `dexdump` of the dex that holds `Lexpo/modules/video/VideoView;` must list `requestDisallowInterceptTouchEvent` among its methods.

## What has been checked

Two dev clients built from one tree (main `35d8cb29`, arm64, debug), one with this patch applied and one without, installed in turn on the Pixel 9a emulator (API 36), plus the stock dev client that was on it (0.1.7, natively the same as main but for the version). The patched APK's dex has the override and the other's does not. Every press carried move events (`adb shell input swipe x y x y 120`). What happened is read from what the app itself reported: a probe screen counts the touch events JS is told of, reads the player's position, and reports each press its buttons answer. "Without the patch" below pools the stock client and the same-tree build without it; they never differed.

| | without the patch | with the patch |
|---|---|---|
| What JS hears of a drag on the seek bar (expo-video's `VideoView` in a React Native `Modal`) | the start, nothing after (5 of 5) | the start, 21 to 27 moves, the end (5 of 5) |
| The clip after that drag | scrubbed, from 0 s to between 2.3 and 2.4 s (5 of 5) | scrubbed, from 0 s to between 1.9 and 2.4 s (5 of 5) |
| …then a `Pressable` beside the player | first press lost, second counts (5 of 5) | first press counts (5 of 5) |
| Seek bar pressed with no drag, then the `Pressable` | first press lost (1 of 1) | first press counts (1 of 1) |
| Seek bar dragged, BACK closes the Modal, then a button on the page behind | first press lost (1 of 1) | first press counts (1 of 1) |
| The app's Reference details sheet on main's JS from before #359: seek bar dragged, then the close button | first press lost (5 of 5) | first press closes (4 of 4) |
| The same sheet: seek bar pressed, then close; a pull down from the title; BACK, then the page behind | first press lost (1 of 1; the other two not run) | first press or pull answers (1 of 1 each) |
| A horizontal scroll view around the player: a drag along the seek bar, against the scroll | the scroll view stays at 0, the clip is scrubbed (1 of 1) | the scroll view stays at 0, the clip is scrubbed (1 of 1) |
| …the same drag on the picture (the control) | the scroll view moves 208 dp | the scroll view moves 212 dp |
| A vertical scroll view: a drag from the seek bar, 200 dp up and across; the same drag from the picture | not run | the scroll view stays at 0 and the clip is scrubbed; from the picture it moves 145 dp |
| A scroll view at its defaults, keyboard up: seek bar pressed, then a button outside the scroll view | first press lost and the keyboard stays, on main's JS and with #359 (1 of 1 each) | first press counts and the keyboard goes away, on both (1 of 1 each) |
| The same scroll view told it is coasting | first press lost, on main's JS and with #359 (1 of 1 each) | first press counts, on both (1 of 1 each) |
| The same page, no keyboard, not coasting (the control) | first press counts (3 of 3) | first press counts (3 of 3) |

With #359 as well, on the patched build, the app's own surfaces answered as before: in the Reference details sheet the close button, a pull from the title and BACK after a drag of the seek bar, a press on play, a press on play that slides 17 dp down, a pull that starts on the clip; on a plain page a button after a drag of the seek bar, a press on play, a scroll that starts on the clip; the lightbox's close button and the result's "Back to creator" after a drag of the seek bar (one round each, all first time).

Also:

- **It round-trips.** `patch-package` applies it on top of the four shipped expo-video patches and reverses it to the file they leave, byte for byte. Applied or not, a plain `patch-package` run (any `npm install`) is content.
- **Parked, it moves nothing.** `scripts/verify-ota-target.mjs` reports both fingerprints equal to the shipped 0.1.8 builds with this folder present. Applied by hand, iOS still matches and Android moves; copied into `patches/`, both move.
- **Tests.** The guard test fails for a release bump that leaves the patch parked, for the patch in both places, for an override that calls through to `ViewGroup` or drops the request, and for a patch cut against another base.

**Not done.**

- No release build and no phone. The store build runs R8 in its pinned shape; an override of a framework method should survive it, and the dex check above says whether it did.
- The coasting case was made by setting the scroll view's own momentum-begin time from the probe, which is what a fling does through `onMomentumScrollBegin`. A fling timed by hand was not tried: while the list is really moving, Android's own scroll view takes the touch-down and the seek bar never sees it, so the case needs a touch in the moment after the list has stopped and before JS has heard so.
- Nothing on iPhone: the patch is Kotlin.

The rig, the two APKs, every log and screenshot are outside git, in `archive/android-video-view-touch-end-2026-10-05/` at the workspace level.

## What the JavaScript fix can drop once this ships

Nothing has to change in JS when this ships. The two fixes were run together and do not get in each other's way. On a build that carries this patch, the three parts of #359 stand like this:

- **The player's view declining the start question** (`leaveTouchToNativeView` returning false, from #357): stays. It is not about the touch's end. A React view that holds a touch for JS has Android cancel the player's buttons at the finger's first movement, and this patch changes nothing there.
- **Stopping the question at the player's view** (`event.stopPropagation()`): no longer needed to keep a holder from being left behind. On the patched build, main's JS from before #359, which lacks it, lost no press: a holder above the player is told the touch ended and lets go. It could go once no Android build without this patch receives JS from main, that is once this build is the Android target in `ota-targets.json`. I would keep it: it costs nothing, and "nothing above a player is asked about its touch" is one rule where the alternative is knowing which views above a player are harmless holders. If it goes, the one thing a person would notice is that a touch on a clip puts the keyboard away again on a `Screen` page.
- **The sheet's drag leaving a player's touch at every move** (`touchBelongsToNativeView` in the move questions of `components/sheet-chrome.tsx`): stays, and has more to do. Without this patch JS never hears a scrub's moves; with it JS hears every one, and each is put to whatever takes a moving touch above the player. Run offline through React Native's own `PanResponder` and renderer with the app's own drag hook, a sheet that asks only at the start takes a scrub that turns downward and closes once the finger has gone 160 dp; with the check it leaves that touch alone. On the emulator the patched build with a sheet that asks only at the start did not close for that pull (2 of 2; the clip was scrubbed). That fits the pull being read in the player's own coordinates, as the view reports them, so it reads shorter than the finger's while the sheet follows it; whether the sheet moved under the finger was not captured. With the check the sheet stayed open as well (1 of 1).

So this patch should not ship in a build whose JS predates #359, and a new view that takes a moving touch above a player with controls must ask `touchBelongsToNativeView` at moves, as `AGENTS.md` says.

## Apply and reverse

After `npm ci` (whose `postinstall` applies the shipped patches):

```sh
./node_modules/.bin/patch-package --patch-dir experiments/android-video-view-touch-end/patches
```

Reverse with `--reverse`. `patch-package --reverse` ignores `--dry-run` and really reverses, so check what is applied by grepping `node_modules/expo-video/android/src/main/java/expo/modules/video/VideoView.kt` for `override fun requestDisallowInterceptTouchEvent`. Reverse it before running `scripts/verify-ota-target.mjs` or publishing an update from the same tree.

## Graduating

In the release bump that the next Android store build is cut from:

1. `git mv experiments/android-video-view-touch-end/patches/expo-video+55.0.21+005+android-video-view-touch-end.patch patches/` and put a "Graduated on" line at the top of this file, as `experiments/ios-light-video-view/README.md` has.
2. If iOS is not rebuilt in the same release, add `patches/expo-video+55.0.21+005+android-video-view-touch-end.patch` to `ios.setAside` in `ota-targets.json`. The patch is Kotlin only: applied by hand it leaves the iOS fingerprint where it is, but any file in `patches/` moves it. This step has not been rehearsed.
3. Record the new Android fingerprint in `ota-targets.json` when that binary ships.

A release that ships no Android binary can repin the version in the guard test instead. Drop the patch when the app moves to an expo-video that carries the change.

## Before promotion

- A release build with the patch, on a phone: the dex lists the override, a clip scrubs, and the press after a scrub answers first time in a sheet and on a page.
- On that build, a scrub inside something that scrolls sideways still scrubs.
- The fullscreen player still opens and closes from a preview, and its own seek bar scrubs (it is another activity with its own player view, not this one).

## Upstream

`upstream-issue.md` is a draft of the report for expo/expo, with the reproduction and this change. It has not been posted. `VideoView.kt` on expo's `main` (expo-video 58.0.6 on 2026-10-05) has the same hook and no override.
