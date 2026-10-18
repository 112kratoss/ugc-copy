---
name: ios-dev-client
description: Open and verify the Magicbooklet mobile app on the iPhone simulator with the dev client and Metro: find the right simulator and app, check for native drift, boot, launch once, prove the bundle loaded, take screenshots and recordings, and avoid the dev-launcher double-load crash. Use whenever a task says "check on iOS", "on the iPhone", "on the simulator", or asks to open the app on both simulators.
---

# iOS simulator and dev client

`scripts/sim.sh` beside this file wraps the steps (`which`, `boot`, `launch`, `shot`, `appearance`). Android has its own skill (`android-device`); run the Android check first and batch the iPhone look at the end, as the owner prefers.

## 1. Which simulator and which app

- `scripts/sim.sh which` lists booted devices and, for the chosen one, every installed `MagicBooklet.app` with its bundle id. The dev client is `com.magicbooklet.mobile` with an `EXDevLauncher.bundle` and no `main.jsbundle`; a release build (the same name, another bundle id) ignores Metro, and its tell is that no `iOS Bundled` line ever appears.
- Native drift: the installed client is a debug build from a known main commit. `git log --oneline <that sha>..origin/main -- ugc-mobile/package.json ugc-mobile/package-lock.json ugc-mobile/patches ugc-mobile/app.config.ts ugc-mobile/app.json ugc-mobile/plugins ugc-mobile/modules` lists what could force a rebuild; a version bump alone does not. Experiments under `ugc-mobile/experiments/` are not applied. A rebuild is `expo run:ios` with `LANG=en_US.UTF-8` (CocoaPods needs a UTF-8 locale) from a path with no space in it (the space in "UGC copy" breaks native builds), with the pinned local CLI.

## 2. Boot and Metro

- `scripts/sim.sh boot [udid]` boots and waits with `bootstatus -b`; the simulator MCP `attach` works only after that. One load at a time also means one simulator at a time for the first launch.
- Metro: `preview_start {name: "metro"}` from the session's launch folder; park its tab on `http://localhost:8081/status`. From the primary checkout the app talks to production. From a worktree the stock entry serves the primary checkout: add a launch entry that `cd`s into the worktree's `ugc-mobile` and runs `./node_modules/.bin/expo start --dev-client --port <port>` (never `npx expo`), and check the banner names the worktree.
- Patches first: `(cd ugc-mobile && ./node_modules/.bin/patch-package)` prints one ✔ per patch.

## 3. Launch once

`scripts/sim.sh launch [udid] [port]` terminates the app and launches it with `--initialUrl http://127.0.0.1:<port>`. A second load started while the first is still fetching its manifest (a tap on a server row, or `simctl openurl` straight after `simctl launch`) makes the dev client build two React instances at once and can die in `NotificationCenterManager.addDelegate` before any JS runs (expo-notifications 55 keeps its delegate list without a lock; the fix waits for the next iOS store build). Launch once, then wait for the app's own UI or the launcher's "Failed to connect" alert, at least 15 s, before any other load.

Proof: one `iOS Bundled …ms` line in `preview_logs` with `search: "Bundled"` (18 to 25 s cold). React Native's blue "Refreshing…" banner at the top goes away within about 30 s. The round gear floating over the app is the dev client's Tools button, not app UI. The simulator shows the app dark; the system appearance there is light and the app overrides it in its own Settings.

## 4. Looking, pressing, recording

- Screenshots: the simulator MCP `screenshot`, or `scripts/sim.sh shot <file.png>` (`xcrun simctl io <udid> screenshot`). Before every tap, a fresh look; the dev client holds a real signed-in account, so never press Generate, Post, Approve, Retry or Start workflow unless the owner asked for that exact action.
- Fast Refresh carries JS edits; prove each with a visible marker string and relaunch between the two captures of any before/after comparison.
- Drags: the MCP `touch_path` and `swipe` scroll a `ScrollView` and drag a sheet but have failed to scroll Home's `FlashList`; when they fail, the XCUITest runner kept in the parent folder's `archive/` is the fallback.
- Recording: `simctl recordVideo` fails here; use `screencapture -v -l<windowid>` of the simulator window. Mute the simulator before comparing video frames with a clock: with sound on, playback lags.
- Keyboard: the on-screen keyboard needs `defaults write com.apple.iphonesimulator AutomaticMinimizationEnabled 0`; then tap its keys.
- LogBox popups over a screen you need to read: `LogBox.ignoreAllLogs()` in a dev-only probe, never in shipped code.
- Appearance: `scripts/sim.sh appearance [light|dark]` prints the current value first; restore the value you read, not the one you assumed.

## 5. Back swipes and gestures (iOS 26)

The back swipe starts anywhere on the screen, not only at the edge, and it beats `usePreventRemove`: screens with a dirty form turn the gesture off while dirty (`gestureEnabled: false`), and screens with their own horizontal drags set `fullScreenGestureEnabled: false`. Check those before blaming a drag that "does nothing".
