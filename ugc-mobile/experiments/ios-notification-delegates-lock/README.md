# iOS notification delegate lock

Status: **written and checked as code; waiting for the next iOS store build, and not yet run inside the app.** The patch is deliberately outside `patches/`, so `postinstall` does not apply it: `@expo/fingerprint` hashes `patches/` and the patched `node_modules/expo-notifications/ios`, and either would stop JavaScript-only updates reaching the binaries already out. It moves into `patches/` in the commit that store build is cut from ("Graduating" below), and `__tests__/ios-notification-delegates-lock.test.ts` fails the release bump that leaves it behind.

## What it fixes

On iOS, expo-notifications keeps two lists on a process-wide singleton, `NotificationCenterManager.shared`: its delegates, and the notification responses no delegate has taken yet. In 55.0.27 both are plain arrays with no lock, and four parties touch them:

- `EmitterModule` and `PushTokenModule` add themselves on the JS thread while an app context registers its modules, before any JavaScript runs.
- `HandlerModule` adds itself on Expo's background queue (`expo.modules.AsyncFunctionQueue`) when JavaScript calls `setNotificationHandler`.
- The modules of an old app context remove themselves on whichever thread frees that context. After a reload that is the old JS thread as its runtime is destroyed, or the new JS thread if the old runtime has already gone.
- iOS reads the delegate list on the main thread for every notification, tapped notification and push-token callback, and adds to the pending list there.

Two of those at the same instant corrupt the array. It was seen on 2026-10-03 as a `SIGSEGV` on the JS thread, in `NotificationCenterManager.addDelegate` under `PushTokenModule.definition()`, 7.8 s after an iOS dev client launched: two React instances had been created back to back, and both were registering modules. A store build makes one instance per cold start, so it cannot repeat that crash. It does reach the same lists from two threads whenever the runtime reloads: `Updates.reloadAsync()` in `lib/use-ota-update-gate.ts`, and expo-updates' relaunch after a fatal error early in a launch. In a model of that collision built from the library's own code, 7% of failures crashed at once, 12% lost one of the new context's modules (notification taps, foreground notifications or the push token then go quiet until the next cold start), 30% left a duplicate entry and 53% left a stale one.

## What it changes

It is Expo's own fix, [expo/expo#49554](https://github.com/expo/expo/pull/49554), released in expo-notifications 57.0.17 and 58.0.0 and never backported to SDK 55. `NotificationCenterManager.swift` is byte-identical in 55.0.27 and in SDK 57 before that fix, so the change applies line for line:

- Both lists move into `NotificationDelegateRegistry`, behind one lock.
- Readers iterate a snapshot. The lock is held only for a list operation, never while a delegate is called: `addDelegate` offers pending responses to the delegate it just added, and a delegate may add or remove delegates from there.
- `removeDelegate` removes every entry for the delegate instead of the first.

One addition. Upstream's registry is written against `Mutex`, a 15-line `NSLock` wrapper that SDK 57's `ExpoModulesCore` ships and SDK 55's does not, so the patch carries a private copy of it in the same file. The only difference between the patched file and upstream's 57.0.17 file is that copy.

It does not change the order in which the library does things. A response that arrives in the instant a delegate is being added can still be left in the pending list, or cleared from it unseen, as before. It also does not touch [expo/expo#48653](https://github.com/expo/expo/issues/48653), where overlapping reloads crash elsewhere in `expo-modules-core`; that one is still open upstream.

## What has been checked

- **It compiles.** The patched file typechecks with the pod's own settings (Swift 5, iOS 15.1) against the simulator and the device SDK, with no errors or warnings, the same as the original. The check swaps `import ExpoModulesCore` for `import UIKit`, since the file uses nothing else from that module; none of the names the patch adds exists anywhere else in the pod or in `expo-modules-core` 55.0.26.
- **The lock holds.** A harness whose manager code is sliced out of the real files as text (the original for one, the patched file for the other) runs two threads through five collisions: two contexts registering at once, a reload, a reload of a context that is only moments old, a callback landing on a registration, and responses arriving while a delegate is added. The original fails every one of them (two registrations released together: 468 of 550 trials). The patched code had no failure in 38 million trials, and ThreadSanitizer reports a race in every collision for the original and none for the patched code.
- **The check measures the lock.** With the helper's two locking lines removed, all five collisions fail again within 5,100 trials, and the single-thread control still passes.
- **It round-trips.** `patch-package` applies it to a clean 55.0.27 and reverses it to the original, byte for byte.
- **Parked, it moves nothing.** `scripts/verify-ota-target.mjs` reports both fingerprints equal to the shipped 0.1.8 builds with this folder present. Applied by hand, Android still matches and iOS moves; copied into `patches/`, both move.

**Not done: a native build.** The patch has never been compiled inside the app or run on a simulator or a phone, so by this repository's rule for native-module bugs it is not yet a confirmed fix. The Mac had about 5 GB free on the day, too little for an iOS build. "Before promotion" below is that check.

The harness and its raw output are outside git, in `archive/notification-delegates-race-2026-10-03/` at the workspace level. The crash report is in `archive/read-alert-keeps-its-age-2026-10-02/rig/crash-reports/`.

## Apply and reverse

After `npm ci` (whose `postinstall` applies the shipped patches):

```sh
./node_modules/.bin/patch-package --patch-dir experiments/ios-notification-delegates-lock/patches
```

Reverse with `--reverse`. `patch-package --reverse` ignores `--dry-run` and really reverses, so check what is applied by grepping `node_modules/expo-notifications/ios/ExpoNotifications/Notifications/NotificationCenterManager.swift` for `NotificationDelegateRegistry`. Reverse it before running `scripts/verify-ota-target.mjs` or publishing an update from the same tree.

## Graduating

In the release bump that the next iOS store build is cut from:

1. `git mv experiments/ios-notification-delegates-lock/patches/expo-notifications+55.0.27.patch patches/` and put a "Graduated on" line at the top of this file, as `experiments/ios-light-video-view/README.md` has.
2. If Android is not rebuilt in the same release, add `patches/expo-notifications+55.0.27.patch` to `android.setAside` in `ota-targets.json`. The patch is Swift only, and with the file set aside Android's fingerprint is the shipped one (rehearsed above).
3. Record the new iOS fingerprint in `ota-targets.json` when that binary ships.

A release that ships no iOS binary can repin the version in the guard test instead. Drop the patch when the app moves to SDK 57 or later, which carries the fix.

## Before promotion

- A native iOS build with the patch applied, on a simulator and on an iPhone.
- The app starts and push registration completes: the device token arrives and the Expo push token resolves.
- A notification that arrives while the app is open shows its banner.
- A tapped notification opens its screen, from a cold start and with the app already running.
- All of the above again after a reload: a Metro reload in a dev client, and an update applied by the gate in a release build.
- A dev client given two loads back to back no longer dies in `NotificationCenterManager.addDelegate`.
