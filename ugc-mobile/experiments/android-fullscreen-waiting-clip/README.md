# Android fullscreen waiting clip

Status: **built into the Android dev client and run on the Pixel 9a emulator (2026-10-05); waiting for the next Android store build. Not yet run in a release build or on a phone.**

The patch is deliberately outside `patches/`, so `postinstall` does not apply it: `@expo/fingerprint` hashes `patches/` for both platforms and hashes the patched `node_modules/expo-video/android`, and either would stop JavaScript-only updates reaching the binaries already out. It moves into `patches/` in the commit the next Android store build is cut from ("Graduating" below), and `__tests__/android-fullscreen-waiting-clip.test.ts` fails the release bump that leaves it behind.

## What it fixes

expo-video's fullscreen player on Android is an activity of its own (`FullscreenPlayerActivity`). When the app is left from it (Home, the lock screen, an incoming call), its `onPause` stops the clip, but only a clip that is playing at that moment:

```kotlin
wasAutoPaused = videoPlayer?.player?.isPlaying == true
if (wasAutoPaused) {
  playerView.useController = false
  videoPlayer?.player?.pause()
}
```

Media3 keeps two facts about a player. `playWhenReady` is the request: play as soon as you can. `isPlaying` is the outcome: the request is set, the player is ready, and nothing holds it back. A clip that has been asked to play and is waiting for data has the first and not the second. So it is not stopped, it keeps its request, and when its data comes it starts: behind the launcher or the lock screen, with sound, looping until the app is opened again.

JavaScript cannot cover it. While the fullscreen player is in front the app's own activity is paused under it, so `AppState` already says `background`, it says nothing more when the app is then left, and the app's timers do not run.

It was seen on the Pixel 9a emulator on 2026-10-05, on the stock dev client, with a clip whose later bytes a fixture server held back. The clip ran out of data 7.8 s in, in the fullscreen player. Home was pressed while it waited, the bytes were let through, and it played on behind the launcher, its audio track started, until the app was opened again. With the screen put to sleep in place of Home it played on with the screen off.

The JavaScript on `main` cannot show this today, because there a preview clip cannot play in the fullscreen player at all: the preview hook pauses whatever starts while `AppState` is not `active`, which is the whole time the fullscreen player is in front. It shows with the change that lets a clip play there ("Let a preview clip play in Android's fullscreen player", branch `fix/android-preview-fullscreen-playback`, not on `main` when this was written). That change holds the fault off in JavaScript with a rule of its own, which this patch makes unnecessary ("What the JavaScript can drop once this ships").

## What it changes

One line of `FullscreenPlayerActivity.onPause`:

```kotlin
wasAutoPaused = videoPlayer?.player?.playWhenReady == true
```

The activity asks whether the clip means to play, not whether it is playing at this moment.

- **A playing clip is stopped as before.** A clip that is playing has its request set, so the new question is true wherever the old one was.
- **A clip that means to play and is not playing yet is stopped too.** Waiting for data is the case that was seen and run. By the code, and not run, the same line covers a player that has no clip ready (one whose clip failed or is being replaced would start when JavaScript hands it a source, as a preview does when it renews a link) and one whose playback is held back for another reason.
- **Nothing else on the way out changes.** It still happens only when the clip is not meant to go on in the background (`staysActiveInBackground`) and the activity is not closing (`didFinish`: BACK and the player's own exit button leave the clip as it is). It still hides the controls and pauses, and `onResume` still brings the controls back.
- **`wasAutoPaused` keeps its meaning and its one reader.** It says that this activity stopped the clip on the way out, and `onPictureInPictureModeChanged` starts such a clip again when the way out turns out to be into picture-in-picture. A playing clip takes that road as before. A waiting clip, which used to be left alone, now takes it too: stopped, then given its request back, it goes on waiting in the window and starts when its data comes, as it did. On the emulator both ended as they do on the stock build: a playing clip was stopped and started again on the way in (JavaScript heard `playingChange` false, then true), and a waiting clip started in the window when its data came.
- **JavaScript hears nothing new.** Taking the request back from a clip that is not playing changes no `playing` value, so no `playingChange` is sent.

### Weighed and not done

- **Asking only whether the clip is waiting for data** (`playbackState == STATE_BUFFERING`). It names the case that was seen and leaves the others above open, and it is the longer line.
- **A second flag beside `wasAutoPaused`** for a clip that was only waiting. Both flags would lead to the same two things (hide the controls and pause; start again in picture-in-picture), so one says it.
- **Leaving a clip that is not playing yet alone when the activity is in picture-in-picture already** (`&& !isInPictureInPictureMode`). It would keep picture-in-picture as it is even on an Android that told the activity of picture-in-picture before pausing it. On the emulator the order is the one expo-video relies on, so it changes nothing there, and it is a second condition to carry. A dev client with it was built and not installed (the archive has it).

### How it gets compiled

Expo's Android modules are linked as prebuilt archives, and a patch to the Kotlin of one is ignored without a word. expo-video is compiled from source here for two reasons already on main: `package.json` lists it under `expo.autolinking.android.buildFromSource`, and `patches/expo-video+55.0.21+002+android-light-player-view.patch` removes the `publication` entry from its `expo-module.config.json`. This patch adds neither.

No shipped patch changes `FullscreenPlayerActivity.kt`, so this one is cut against the file as expo-video 55.0.21 ships it (its `index 721a944..` line). It carries the number `+006+` because `+005+` is the other parked expo-video patch (`experiments/android-video-view-touch-end/`, which changes `VideoView.kt`); the two do not meet in any file.

To check that a build really carries it, look in the APK, not the build log. The patch adds no method, so the method list is the same either way; what differs is the body of `onPause`. `dexdump -d` of the dex that defines `Lexpo/modules/video/FullscreenPlayerActivity;` must show `ExoPlayer;.getPlayWhenReady:()Z` in `onPause` and no `ExoPlayer;.isPlaying:()Z` there.

## What has been checked

Three dev clients (arm64, debug) built from one tree, main `13087bdd`, whose native side is unchanged up to `d2439c5b`: with this patch, without it, and with this patch and the other parked expo-video patch together, as the next store build would have them. The fourth build is the stock dev client that was on the emulator (0.1.7). Each APK's dex was read: `onPause` calls `getPlayWhenReady` in the patched ones and `isPlaying` in the others, the stock one included, and no other instruction of the method differs.

They were installed in turn on the Pixel 9a emulator (API 36) and loaded one JavaScript bundle. Its preview hook is `main`'s with the fullscreen change merged in, switched per case between the hook as it stands ("rule on") and the same without its two-second rule ("rule off"), so that whatever stops a clip in the second is native. The clip's later bytes were held back by a fixture server and let through on cue. What the clip did is read from what the app itself reported (each player's native clock, which goes on while the app is away, and every `pause()` called from JavaScript with its caller) and from the system (the audio track's state, the activity in front, the windowing mode, whether the screen is awake). Every press was 120 ms with move events, on the player's own buttons.

| | without the patch | with the patch |
|---|---|---|
| A clip waiting for data in fullscreen, Home, its data let through (rule off) | it plays behind the launcher, audio track started (stock 2 of 2, same tree 2 of 2) | it stays stopped; its data arrived, and nothing in JavaScript called `pause()` (3 of 3; with both patches 1 of 1) |
| The same with the screen put to sleep in place of Home (rule off) | it plays with the screen off (stock 1 of 1) | it stays stopped (with both patches 1 of 1) |
| …then back through the app switcher, or the screen woken | the fullscreen player is in front and the clip is playing (5 of 5) | the fullscreen player is in front and the clip is stopped; its play button starts it (6 of 6), on the second press: the first brings the controls up, as after any return to that player |
| Home while a clip plays in fullscreen | stopped (5 of 5) | stopped (6 of 6) |
| A clip waiting in fullscreen, Home, its data let through (rule on) | not run here | it stays stopped, and the rule's own `pause()` when the data comes finds nothing to stop (1 of 1) |
| The person stays in fullscreen; the data comes 5 s after the clip ran out | not run here | rule off: it goes on by itself (1 of 1). Rule on: it waits, and one press plays it (1 of 1) |
| Fullscreen from a playing clip keeps playing; pause and play answer there; BACK leaves it playing, or paused if it was paused there; fullscreen from a paused clip plays when pressed; Home stops it, back through the app switcher it is stopped and play answers, back through the app's icon it is paused on the page (rule off) | not run here | 6 of 6, and 6 of 6 with both patches |
| Picture-in-picture: a clip playing in fullscreen, Home | it is in the window and playing, stopped and started again on the way (stock 1 of 1) | the same (1 of 1) |
| Picture-in-picture: a clip waiting in fullscreen, Home, its data let through | it starts in the window (stock 1 of 1) | the same (1 of 1) |
| A clip waiting in its own place, Home, its data let through, JavaScript told to do nothing | it stays stopped (stock 1 of 1) | it stays stopped (1 of 1) |

The rows marked "not run here" have their runs on the stock dev client, with the rule on, in the fullscreen change's own evidence (`archive/android-preview-fullscreen-2026-10-05/`). The app has no view that enters picture-in-picture, so for those two rows the probe mounted expo-video's own `VideoView` with `startsPictureInPictureAutomatically`, with no hook of the app on it.

Also:

- **It round-trips.** `patch-package` applies it on top of the four shipped expo-video patches and reverses it to the file they leave, byte for byte, alone or beside the other parked patch. Applied or not, a plain `patch-package` run (any `npm install`) is content.
- **Parked, it moves nothing.** `scripts/verify-ota-target.mjs` reports both fingerprints equal to the shipped 0.1.8 builds with this folder present. Applied by hand, iOS still matches and Android moves; copied into `patches/`, both move.
- **Tests.** The guard test fails for a release bump that leaves the patch parked; for the patch in both places; for a patch that asks anything but `playWhenReady`, sets `wasAutoPaused` a second time, or drops the `staysActiveInBackground` test; for another expo-video patch with its number; for a shipped patch that changes the same file; for shipping ahead of the lower-numbered parked patch; and for the two-second rule taken out of the hook while the patch is parked. With both parked patches moved into `patches/` at a release bump, this guard and the other patch's both pass.

**Not done.**

- No release build and no phone. The store build runs R8 in its pinned shape; "Before promotion" below is that check.
- The HOME and SLEEP keys stood in for a finger and for the lock. A call or another app coming over the fullscreen player was not tried; it reaches the same `onPause`.
- Picture-in-picture was entered by the HOME key only, on API 36. There the patch leans on what expo-video already leans on: that the activity hears `onPause` before `onPictureInPictureModeChanged`. On an Android that tells it the other way round, expo-video as it is leaves a playing clip stopped in the window, and with the patch a waiting one would be left so too.
- Nothing on iPhone: the patch is Kotlin.

The rig, the APKs, every log and the screenshot kept before every input are outside git, in `archive/android-fullscreen-waiting-clip-2026-10-05/` at the workspace level.

## Clips in their own place need no change

`VideoManager.handleVideoPause` asks `isPlaying` too, for a clip in its own place as the app's own activity pauses. It does not need this change.

- **It is not what stops a waiting clip there.** `VideoManager.onAppBackgrounded` goes on to its listeners, and `PictureInPictureManager.onAppBackgrounded` pauses the player of every view that is not in fullscreen and is not meant to go on in the background, without asking whether it plays. (That holds while no view is set to enter picture-in-picture, which is always so in this app.) On the emulator a clip waiting for data in its own place stayed stopped when its data came behind the launcher, on the stock build and on the patched one, with the preview hook switched to do nothing about `AppState` or a window blur and nothing in JavaScript calling `pause()`.
- **JavaScript hears that leaving as well.** There the app's own activity is the one that pauses, so `AppState` says `background`, and the hook takes back a pending request by itself (seen in the same run with the hook as it stands).
- **What its test does decide** is `VideoView.wasAutoPaused`, which only helps to choose the view that goes into picture-in-picture (`findAutoPiPViewCandidate`). Changing it would change that choice and nothing a person meets in this app.

One gap of the same kind stays in JavaScript's hands. For a moment after the fullscreen player has closed (BACK, then Home before its activity is destroyed) expo-video still counts the view as in fullscreen and stops nothing there, playing or waiting. The app's own activity is the one that pauses then, so the hook hears it and pauses.

## What the JavaScript can drop once this ships

The JavaScript guard against this fault is a rule in `lib/use-native-preview-playback.ts`: a clip that has waited more than two seconds for data behind its own fullscreen player is not started by its data; it waits for a press on play (`LONG_WAIT_MS`). The rule comes with the change that lets a preview clip play in the fullscreen player at all ("Let a preview clip play in Android's fullscreen player", branch `fix/android-preview-fullscreen-playback`), which was not on `main` when this was written. It is a guess made without the one fact JavaScript lacks, and it costs something: after a long stall in fullscreen the clip does not go on by itself even when the person is still watching.

**When it can go:** when the `android` entry in `ota-targets.json` is a build that was cut with this patch in `patches/`. Updates reach only builds whose fingerprint matches that entry, so from then on no JavaScript from `main` runs on an Android build without the patch. The guard test holds this: while the hook has `behindFullscreen` it must have `LONG_WAIT_MS`, until the patch ships from `patches/` and the Android target's fingerprint is in the test's `androidBuildsWithThePatch` list. Both names are that change's. Until it is on `main` the hook has neither and the test holds nothing; if they are renamed before it lands, rename them in the test.

**What goes, in the hook:**

- `LONG_WAIT_MS` and its comment;
- `waitingSince`, `waitedLongUnseen` and the comment above them;
- the `statusChange` listener (`status`) and its `status.remove()`;
- in the `playingChange` listener, everything but what `main` has today: `if (event.isPlaying) claim(); else nativePreviewPlaybackOwner.release(player);`.

The rest of that change stays. `behindFullscreen`, and what the `change` and `blur` listeners do with it, is what lets a clip play in the fullscreen player; this patch does not touch that. So does the pause when the app is left just after fullscreen has closed and before its activity is destroyed: there the app's own activity is the one that pauses, JavaScript hears it, and expo-video still counts the view as in fullscreen and stops nothing.

**Which tests change:**

- `__tests__/native-preview-playback-hook.test.tsx`
  - These two go: "does not let a clip start by itself behind its Android fullscreen player after a long wait for data, and lets a press start it", and "stops such a clip when its start is heard before its data".
  - "lets a clip go on by itself behind its Android fullscreen player after a short wait, as after a seek" then holds for any wait. Give it the long one (8000 ms) and take "short" out of its name, or fold it into "lets a clip go on by itself after a long wait where the app can tell it is in front" as an `['android', true]` row.
  - The helper `dataArrives` calls the `statusChange` listener, which is gone: it only sets the status then, and `mountWaiting` no longer needs its `Date.now` spy.
- `__tests__/recoverable-video-preview-android-fullscreen.test.tsx`
  - Its stand-in for the phone has to follow the patched activity: `homeFromFullscreen` takes the request back from every clip that wants to play (`wantsToPlay`), not only from a playing one, and the header comment's lines for "Home in fullscreen" and "a clip out of data" say so.
  - "does not start behind the launcher a clip that was waiting for data in fullscreen when the app was left" then passes because of the stand-in, not because of the hook. Keep it for its second half (a press on play still starts the clip) and drop its `Date.now` spy.
  - "lets a clip in fullscreen go on by itself after a short wait for data, as after a seek" holds for any wait: make the wait long, so that it is the test that fails if the rule comes back.
  - "lets a clip on the page go on by itself after a long wait for data" does not change.

What a person sees then: in fullscreen on Android a clip that has stalled for more than two seconds goes on by itself again when its data comes. On the patched build with the rule switched off, a clip whose data came 5 s after it ran out went on by itself, the person still in the fullscreen player; with the rule on it waited for a press, as it does today.

## Apply and reverse

After `npm ci` (whose `postinstall` applies the shipped patches):

```sh
./node_modules/.bin/patch-package --patch-dir experiments/android-fullscreen-waiting-clip/patches
```

Reverse with `--reverse`. `patch-package --reverse` ignores `--dry-run` and really reverses, so check what is applied by grepping `node_modules/expo-video/android/src/main/java/expo/modules/video/FullscreenPlayerActivity.kt` for `playWhenReady == true`. Reverse it before running `scripts/verify-ota-target.mjs` or publishing an update from the same tree.

## Graduating

In the release bump that the next Android store build is cut from:

1. `git mv experiments/android-fullscreen-waiting-clip/patches/expo-video+55.0.21+006+android-fullscreen-waiting-clip.patch patches/` and put a "Graduated on" line at the top of this file, as `experiments/ios-light-video-view/README.md` has.
2. Graduate `experiments/android-video-view-touch-end/` (`+005+`) in the same commit, or before. patch-package applies a package's patches in the order of their numbers and refuses a tree whose applied patches are not the first of that order: with `+006+` shipped and `+005+` added later, every tree that already has an install stops at `npm install` with "The patches for expo-video have changed" until it is reinstalled (rehearsed). The guard test fails that order. If the two cannot go together, rename the later one to a number above every expo-video patch in `patches/`; nothing in either file depends on its number. Together they apply in order from a tree at 001 to 004 (rehearsed), both guard tests pass with the two side by side in `patches/`, and a dev client built with both ran on the emulator (above).
3. If iOS is not rebuilt in the same release, add `patches/expo-video+55.0.21+006+android-fullscreen-waiting-clip.patch` to `ios.setAside` in `ota-targets.json`. The patch is Kotlin only: applied by hand it leaves the iOS fingerprint where it is, but any file in `patches/` moves it. This step has not been run through `scripts/publish-ota.mjs`.
4. When that binary ships, record the new Android fingerprint in `ota-targets.json` and add it to `androidBuildsWithThePatch` in the guard test. From that commit on the two-second rule can go ("What the JavaScript can drop once this ships").

A release that ships no Android binary can repin the version in the guard test instead. Drop the patch when the app moves to an expo-video that carries the change.

## Before promotion

- A release build with the patch: its dex shows the call in `onPause`. R8 may rename the Media3 method, so read it with that build's `mapping.txt`.
- On a phone, with that build:
  - Home while a clip plays in fullscreen still stops it, it is still stopped back through the app switcher, and its play button starts it.
  - BACK and the fullscreen player's own exit button still leave a playing clip playing in its place.
  - The waiting case itself, where a clip can be made to wait. It needs a clip that is not loaded whole yet, and the app's clips are short, so a slow connection helps. Start the clip, open its fullscreen player, switch the network off from the quick settings (the shade pauses no activity), wait until the clip stops with its spinner up, press Home, switch the network on again. No sound starts. Back through the app switcher the fullscreen player shows the clip stopped, and its play button starts it. Then the same with the screen locked in place of Home.

## Upstream

`FullscreenPlayerActivity.kt` on expo's `main` (expo-video 58.0.6 on 2026-10-05) has the same `onPause`, reading `isPlaying`. No report has been written for expo/expo.
