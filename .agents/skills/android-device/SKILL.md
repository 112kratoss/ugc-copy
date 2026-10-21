---
name: android-device
description: Drive the Pixel_9a emulator or the owner's Samsung S24 over adb for Magicbooklet checks: boot, launch the dev client on Metro, look before every tap, press native players with a swipe, record motion, read expo-updates and app logs, and hand the device back. Use whenever a task says "check on Android", "on the emulator", "on the phone" or "on the S24", or for the on-phone half of an OTA check. The S24 is the owner's personal phone: read the phone section before touching it.
---

# Android devices

Scripts beside this file: `scripts/emulator.sh` (lock, boot, launch, shot, restarts; all but lock and unlock refuse a serial that is not an emulator's), `scripts/phone.sh` (one short command per step on the S24), `scripts/keep-awake.sh`, `scripts/ui_find.py` (on-screen controls with their centres, for taps). The shell scripts run under the Mac's `/bin/bash`, which is 3.2: `shell-scripts.test.ts` parses every tracked shell script with the interpreter its first line names, and `android-device-phone-script.test.ts` runs phone.sh, keep-awake.sh and emulator.sh's guard against a stand-in adb. `ANDROID_SERIAL` picks the device; `adb devices` lists serials. The package is `com.magicbooklet.mobile` (the `.dev` build claims the same deep-link scheme, so name the package in every `am start`).

## 1. Is the device free?

- Emulator: read the lock file in the parent folder of the primary checkout, `UGC copy/.claude/emulator-5554.lock` (`scripts/emulator.sh lock 20` reads it, refuses if another session holds it, else writes our line for about 20 minutes; `unlock` removes it). Another session in a loop shows as several app restarts in the last ten minutes (`scripts/emulator.sh restarts`) and a Metro on another port (`lsof -nP -iTCP:8081 -iTCP:8082 -sTCP:LISTEN`). If it is someone else's, message that session with what you need and for how long, and do other work meanwhile. Never start a second emulator instance of the same AVD.
- Phone: section 6, every time.

## 2. Boot and Metro

- `scripts/emulator.sh boot` starts `Pixel_9a` detached with `-dns-server 8.8.8.8,1.1.1.1` (without it every request fails on this Mac) and waits for `sys.boot_completed`. After a Mac restart the emulator may boot an older snapshot: the app is signed out and its settings are back in time.
- Metro: `preview_start {name: "metro"}` from the session's launch folder, then park its tab on `http://localhost:8081/status` (the root URL tries a web bundle and floods the log). From a worktree the stock entry serves the primary checkout, so add a launch entry that `cd`s into the worktree's `ugc-mobile` and run the pinned `./node_modules/.bin/expo start --dev-client --port <port>`; never `npx expo`. Check the banner says the worktree's path before debugging any UI that will not update.
- Patches first: `(cd ugc-mobile && ./node_modules/.bin/patch-package)` should print one ✔ per patch; a lone failing mobile test about an undefined component means they were lost.

## 3. Launch the dev client, once

`scripts/emulator.sh launch [port]` force-stops the app and opens the dev launcher link `exp+magicbooklet-mobile://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A<port>` (default 8081). The force-stop is mandatory: a link into a live app reloads nothing. Proof is one `Android Bundled …ms` line in `preview_logs` with `search: "Bundled"`; cold bundles take 12 to 25 s. Fast Refresh then carries JS edits; prove each one with a visible marker string ("… · r2") read back from a screenshot or `scripts/ui_find.py`, and for any before/after comparison relaunch between the captures rather than trusting a reverted edit landed. Blank bundled images and `LoadBundleFromServerRequestError` mean Metro is gone: restart that same Metro.

## 4. Look before every tap

The dev clients hold a real signed-in account; a wrong tap can spend credits, upload, post or follow.

- Take the screenshot in the same command as the tap, straight before it: `scripts/emulator.sh shot <file.png>` (it falls back to a host-side capture when adb returns a white 10 KB frame). After the tap, another look before the next one.
- Find controls by label: `ANDROID_SERIAL=emulator-5554 python3 scripts/ui_find.py "Post" "Close"` prints centre coordinates. While a video is on screen the UI dump never goes idle and can print the previous screen: check a screenshot before trusting it.
- Never tap Generate, Start workflow, Post, Approve or Retry unless the owner asked for that exact action. Anything that opens a system surface (picker, share sheet, permission prompt) ends the sequence: look, then close it with BACK (`input keyevent 4`).
- `adb shell input tap` sends no move event and passes faults a finger finds: press native players and anything near one with `adb shell input swipe x y x y 120`. Scroll with drags that start in a gap between rows, never within about 200 px of the bottom edge (the home gesture) and never over a floating bar.
- The round gear floating over the app is the dev client's Tools button, not app UI; it eats top-right taps. The emulator follows its own light theme.
- A scripted loop needs the look built in: read a mark the screen under test paints before every input, confirm where the app is after every BACK or link, and never infer a state from one pixel of the thing being changed.

## 5. Logs and recordings

- App `console.log` lines arrive in `preview_logs` as `LOG …`, never in logcat; start each probe line with a tag and read with `search: "<tag>"`.
- expo-updates and crashes: `adb logcat -d -T "<device time>" --pid=$(adb shell pidof com.magicbooklet.mobile)`; the device time comes from `adb shell "date '+%m-%d %H:%M:%S.000'"` (one quoted string, the device shell splits at spaces). Never `logcat -c`.
- Motion: `adb shell screenrecord --bugreport --size 360x808 /sdcard/r.mp4`, pull it, then `ffmpeg -fps_mode vfr -vf "select='gt(t,0.3)',scale=150:-1,tile=9x6"` for a distinct-frame sheet; Perfetto for stalls. Film entrance and exit on both platforms before calling motion done.
- Known emulator faults, not regressions: a paused preview clip with controls and no picture (retake), one hung player followed by every later one until the app restarts (never-ready is not blank), black wedges at the screen corners after a force-stop in landscape fullscreen, and a nearly full `/data` wiping the video cache every minute (`df` first).

## 6. The owner's S24

It is their personal phone, with their references on screen and WhatsApp calls in the foreground; nothing here may steal focus or capture private content. `ANDROID_SERIAL=<serial from adb devices>` for every call; `PKG=com.magicbooklet.mobile.dev` for the dev build.

1. `scripts/phone.sh state`: connected, awake, keyguard, what is in front, call state, audio mode, touches in the last six seconds. Proceed only when it is unlocked, the launcher or our app is in front, `MODE_NORMAL`, no call and no `ViewPostIme pointer` line in the last six seconds; `scripts/phone.sh free` exits 0 exactly then. A call is any entry in telecom's list of current calls, cellular or an app's such as WhatsApp's, and a dump it cannot read counts as one. A call does not always show in the foreground: the audio mode is the tell.
2. Keyguard showing: ask the owner to unlock, then start `scripts/keep-awake.sh <minutes>` in the background (`input keyevent 0` every 12 s; it stops by itself when the screen goes off or another app comes in front, and `pkill -f keep-awake.sh` stops it early). The phone sleeps after 30 s. Never write a settings value (`svc power stayon`) to keep it on.
3. Restart with the screen on: `scripts/phone.sh restart [deep link]`. A cold start behind the lock screen under battery saver gets no network and reads as a failed update download. `scripts/phone.sh logs <since>` (the time from `scripts/phone.sh now`) prints the expo-updates lines: success is `appLoaderTask didLoadAsset … totalAssetCount=N`, then `DownloadComplete … isUpdatePending=true`; a second start reads `CheckCompleteUnavailable`.
4. Read the version: `scripts/phone.sh open magicbooklet://settings`, scroll with gap drags to the footer, `Version 0.1.x (build) · update <group>`.
5. A press on the phone only when the owner asks for it: find the target by label, confirm it in the fresh screenshot, keep it 300 px or more from destructive buttons (Generate, Remove reference), and `scripts/phone.sh press x y`. Close a Modal with BACK (`scripts/phone.sh tapkey 4`), never a tap near a destructive row.
6. Leave the phone as found. A deep-link start becomes the task's root, so finish with `scripts/phone.sh home` (a launcher-style start that clears the task) only if the launcher was in front when you began and no touch is less than five seconds old; otherwise leave the screen alone. Screenshots of the phone stay in the scratchpad and never go into `archive/`. Never script feed scrolling on the production app: every impression is a production write.

## 7. Hand back

Relaunch the emulator's app at `10.0.2.2:8081` if you moved it to another Metro, delete your lock line (`scripts/emulator.sh unlock`), stop keep-awake, and tell the other sessions.
