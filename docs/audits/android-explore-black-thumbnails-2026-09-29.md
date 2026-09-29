# Android Explore thumbnails disappearing after a covered resize

Status: reproduced on the physical phone; JS mitigation verified on that phone.
The change has not been published to the production OTA channel.

## Failure and reproduction

Samsung SM-S928B, Android 16/API 36. The installed production app was version
0.1.8/build 76. Its original process (PID 21459) was kept alive throughout the
investigation; its data and image caches were not cleared.

Explore's media areas were black while badges, text and avatars were visible.
Opening an affected post displayed its image. Waiting, scrolling, changing tabs,
and returning from a post did not restore the grid. The saved log showed
successful Glide image loads around a landscape/portrait change. Native view
inspection showed full-sized, visible `ExpoImageViewWrapper` instances containing
two `ExpoImageView` children both marked `G` (GONE).

Reproduction on the production app and then on an unmodified diagnostic build:

1. Open Explore and wait for thumbnails to display.
2. Tap a creator's name under a thumbnail to open the creator profile.
3. Rotate landscape, wait one second, then rotate portrait while the profile
   covers Explore.
4. Return to Explore. Still-image thumbnails are black; an actively playing
   video and fixed-size avatars may remain visible.

For deterministic device automation, temporarily override the portrait lock:

```sh
adb shell wm fixed-to-user-rotation enabled
adb shell wm user-rotation lock 3
sleep 1
adb shell wm user-rotation lock 0
adb shell wm fixed-to-user-rotation default
sleep 1
adb shell input keyevent 4
```

Restore the phone's original rotation settings after testing (this phone was
`fixed-to-user-rotation default`, `user-rotation lock 0`). Merely changing the
display's dimensions or rotating a visible grid did not reproduce the failure.
The covered screen and real orientation change matter.

## Cause and correction

`StableMediaImage` used a 120 ms native `expo-image` fade on Android. Installed
`expo-image` 55.0.11 alternates between two native image views. Its delayed
fade-out completion recycles the previous view without checking whether a later
load has rebound that view. Resizing the covered screen causes image loads while
the native views are detached. The transition lifecycle can leave both image
layers recycled/hidden after the screen returns. `onDisplay` fires before fade
completion, so a load watchdog does not detect this later disappearance.

The upstream native transition ownership/cancellation problem is documented in
[Expo #49283](https://github.com/expo/expo/pull/49283), merged September 23. Its
native correction is not in the installed implementation. The source inspected
was `ExpoImageViewWrapper.onResourceReady` and `ExpoImageView.recycleView` in
`node_modules/expo-image/android/src/main/java/expo/modules/image/`; the extracted
production and diagnostic APK implementations also contain this transition path.

Set `transition={0}` for Android inside `StableMediaImageSession`, including
when callers explicitly request a fade. Expo's existing synchronous image-swap
path then clears the outgoing layer immediately, without a deferred animation
cleanup. Keep the caller's transition on iOS. This protects the shared feed
images and video posters without remounting every feed, refetching media, or
changing cache identity. It changes only the Android thumbnail fade.

Re-enabling Android fades requires a store binary with the corrected native
implementation and repeating this device reproduction. A dependency bump alone
does not change the native code in an already installed binary.

## Verification

The diagnostic app used a separate package (`com.magicbooklet.mobile.lab`), the
existing local release APK's native libraries, and production-configured JS
bundles from clean commit `717017c0` in an isolated worktree. Expo Updates was
disabled for that diagnostic package. Baseline and fixed runs used the same
native APK; the only application source difference was the Android transition
guard. The production app was not replaced or signed into through the diagnostic
app. Exports used a private Metro cache; the fixed source map confirms the guard
is in the tested bundle.

| Check | Result |
| --- | --- |
| Production app, covered rotation then return | Black thumbnails reproduced |
| Diagnostic baseline, same sequence | Black thumbnails reproduced; both native image children GONE |
| Diagnostic fix, same sequence twice | Thumbnails remain visible; one native image child VISIBLE |
| Fixed build: post open/return, scroll, background/resume | Images remain visible |
| Media-preview, feed-media-frame, showcase-media-preview tests | 56 tests passed |
| Mobile TypeScript check | Passed |

The added unit cases guard the Android/iOS prop contract; native before/after
testing above is the rendering regression evidence.

Local captures and logs are in `/tmp/explore-black-diagnostic/`, including
`before.png`, `profile-rotation-back.png`, `lab-baseline-rotation-back.png`,
`lab-baseline-native-views.txt`, `lab-fixed-rotation-back.png`,
`lab-fixed-native-views.txt`, and `lab-fixed-repeat.png`. They are local diagnostic
artifacts, not files required by the app.

Finally, a temporary display resize and reset restored the original production
process's thumbnails without restarting it. That recovers this instance only;
the code correction still needs an Android OTA release through the repository's
`publish-ota.mjs` workflow to reach the Play-installed app.
