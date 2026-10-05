<!--
A draft for expo/expo. NOT posted: the owner sends it.

How to send it: https://github.com/expo/expo/issues/new/choose, "SDK Bug Report". The form has four
required fields. The four sections under "The form" below hold the text for each, in the form's
order; the title is the line above them.

- Field 1 is the reproduction's public repository, https://github.com/112kratoss/expo-video-time-bar-touch, published on
  2026-10-05: `create-expo-app` on SDK 57, expo-video added, the App.tsx below and a generated
  10-second clip. Its local copy is archive/android-video-view-touch-end-2026-10-05/fresh-project/repo/
  at the workspace level, outside this repository.
- The fresh project was built and run on 2026-10-05 on the Pixel 9a emulator, once as it is and once
  with the proposed change. Both APKs, their dex checks, the logs and every screenshot are in
  archive/android-video-view-touch-end-2026-10-05/fresh-project/.
- The second table under "What we observed" is from this app's own dev clients on Expo SDK 55:
  archive/android-video-view-touch-end-2026-10-05/evidence/.
-->

**Title:** [expo-video][Android] With `nativeControls`, a touch on the time bar reaches JS as a start with no end, and the next press anywhere is ignored

## The form

### Minimal reproducible example

https://github.com/112kratoss/expo-video-time-bar-touch

### Steps to reproduce

Android. Seen in a standalone release build of the linked project on an Android emulator (Pixel 9a image, API 36), and in development builds of our own app on Expo SDK 55. Package manager: npm. Not tried in Expo Go or on iOS; the cause below is in the Android view.

1. `npm install`, then `npx expo run:android --variant release`.
2. Press **OPEN**.
3. Drag the player's time bar. A press on the bar with no drag does the same.
4. Read the line under the button, which says which touches on the player JS was told of. It has gained one start, and no move and no end.
5. Press **Pressed 0 time(s)**.

**Expected:** the count goes to 1.

**Actual:** the first press does nothing. The second counts.

A drag across the picture, away from the time bar, does not do this: JS is told of its start, its moves and its end, and the press after it counts first time.

`App.tsx` is the whole reproduction:

```tsx
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Button, Modal, Pressable, Text, View } from 'react-native';

// A 10-second test card with a seconds counter, bundled so that nothing depends on the network.
const source = require('./assets/clip.mp4');

export default function App() {
  const player = useVideoPlayer(source);
  const [open, setOpen] = useState(false);
  const [presses, setPresses] = useState(0);
  const [heard, setHeard] = useState({ start: 0, move: 0, end: 0 });
  const count = (kind: keyof typeof heard) => setHeard((now) => ({ ...now, [kind]: now[kind] + 1 }));

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <Button title="Open" onPress={() => setOpen(true)} />
      <Modal visible={open} onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 24 }}>
          <View onTouchStart={() => count('start')} onTouchMove={() => count('move')} onTouchEnd={() => count('end')}>
            <VideoView player={player} nativeControls style={{ height: 300 }} />
          </View>
          <Pressable onPress={() => setPresses((n) => n + 1)} style={{ padding: 16, backgroundColor: '#ddd' }}>
            <Text>Pressed {presses} time(s)</Text>
          </Pressable>
          <Text>
            Touches on the player, as JS heard them: {heard.start} start, {heard.move} move, {heard.end} end
          </Text>
        </View>
      </Modal>
    </View>
  );
}
```

#### What is going on

On Android, a `VideoView` with `nativeControls` tells React Native when a touch on it starts. If the touch lands on the player's time bar, it never tells React Native that the touch ended.

JS is left with a touch that is in progress forever. Whichever view became the JS responder when that touch started keeps the responder, React Native routes the next touch to it instead of to the view under the finger, and that touch is lost. Its end finally releases the responder, so the touch after it works.

The `Modal` is only there to make the stale responder visible: React Native's `Modal` answers `onStartShouldSetResponder` with `true` for every touch-down that reaches it ([`Modal.js`](https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/Libraries/Modal/Modal.js#L347)), so it becomes the responder when the touch starts and is never released. Any ancestor that takes touch-downs shows it the same way, for example a `ScrollView` left at the default `keyboardShouldPersistTaps` while the keyboard is up, or a `ScrollView` that is still decelerating. Those two claim in the capture phase, so an app cannot get in ahead of them from the player's side.

#### Cause

1. With `nativeControls` the view reports touches to JS from `onInterceptTouchEvent` ([`VideoView.kt`](https://github.com/expo/expo/blob/60462bad56846fc4b045899d09e4596e3f0ec39e/packages/expo-video/android/src/main/java/expo/modules/video/VideoView.kt#L408-L417)):

   ```kotlin
   override fun onInterceptTouchEvent(event: MotionEvent?): Boolean {
     if (useNativeControls) {
       event?.eventTime?.let {
         touchEventCoalescingKeyHelper.addCoalescingKey(it)
         reactNativeEventDispatcher?.dispatchMotionEvent(this@VideoView, MotionEvent.obtainNoHistory(event), touchEventCoalescingKeyHelper)
       }
     }
     // Return false to receive all other events before the target `onTouchEvent`
     return false
   }
   ```

2. `ViewGroup.dispatchTouchEvent` calls `onInterceptTouchEvent` only while the group's `FLAG_DISALLOW_INTERCEPT` is clear.
3. Media3's time bar sets that flag on all of its ancestors as soon as a touch lands on it: `DefaultTimeBar.onTouchEvent` calls `startScrubbing` on `ACTION_DOWN`, which calls `getParent().requestDisallowInterceptTouchEvent(true)` ([`DefaultTimeBar.java`](https://github.com/androidx/media/blob/1.9.0/libraries/ui/src/main/java/androidx/media3/ui/DefaultTimeBar.java#L796-L803)). `ViewGroup.requestDisallowInterceptTouchEvent` records it on each ancestor on the way up, `VideoView` included.
4. So for that gesture the hook runs for `ACTION_DOWN` (the view sees it before the time bar does) and for nothing after. JS receives `topTouchStart` and no `topTouchMove` or `topTouchEnd`.
5. React's responder system releases the responder on a touch end with no touches left, which never arrives. Its count of touches in progress (`trackedTouchCount`) also stays one too high after every such touch.

#### Proposed change

Keep the hook alive: pass the request on to the views above without recording it on this view.

```diff
--- a/packages/expo-video/android/src/main/java/expo/modules/video/VideoView.kt
+++ b/packages/expo-video/android/src/main/java/expo/modules/video/VideoView.kt
@@ override fun onInterceptTouchEvent(event: MotionEvent?): Boolean {
     // Return false to receive all other events before the target `onTouchEvent`
     return false
   }
+
+  // A child that wants a gesture to itself asks its parents not to intercept it: the controls' time bar does, as soon as
+  // a touch lands on it. A view that records that request is not asked `onInterceptTouchEvent` again until the gesture
+  // ends, so JS would hear the touch start and never its end. This view never intercepts, so it has nothing to give up:
+  // it passes the request on to the views above without recording it, as React Native's root views do.
+  override fun requestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {
+    parent?.requestDisallowInterceptTouchEvent(disallowIntercept)
+  }
```

- The view's hook always returns `false`, so it never intercepts and its children lose nothing. The flag has one reader in Android, the check in `ViewGroup.dispatchTouchEvent` that decides whether to call `onInterceptTouchEvent`.
- The ancestors still receive the request, so a scroll view around the player still cannot take a scrub.
- React Native's root views do the same, for the same reason: [`ReactRootView.requestDisallowInterceptTouchEvent`](https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java#L453-L460) and [`ReactSurfaceView`](https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactSurfaceView.kt#L132-L136) ("Override in order to still receive events to onInterceptTouchEvent even when some other views disallow that, but propagate it up the tree if possible").

An alternative with the same effect would be to report from `dispatchTouchEvent`, which Android calls for every event whatever the flag says. I have not tried that one.

#### What we observed

**The linked project** (Expo SDK 57, expo-video 57.0.5, React Native 0.86.3, Media3 1.9.0), release build, on an Android emulator (Pixel 9a image, API 36). The second column is the same project with the change above applied to `node_modules/expo-video` and the module compiled from source (`expo.autolinking.android.buildFromSource`); each APK's dex was checked for the method. Every press was sent with `adb shell input swipe x y x y 120`, which carries move events as a finger does (`input tap` sends none), and what happened was read from the app's own two lines of text.

| | as published | with the change |
|---|---|---|
| What JS is told of a drag along the time bar | one touch start, no move, no end (3 of 3) | one touch start, 36 moves, one end (3 of 3) |
| …of a press on the time bar with no drag | one touch start, no move, no end (1 of 1) | one touch start, 7 moves, one end (1 of 1) |
| The clip after those four touches | scrubbed: 00:00, then 00:06, 00:02, 00:04 | scrubbed: 00:00, then 00:06, 00:03, 00:04 |
| The `Pressable`, pressed twice after each of them | first press ignored, second counts (4 of 4) | both presses count (4 of 4) |
| Two presses with nothing sent to the player | both count | both count |
| A drag across the picture, then two presses | JS is told of a start, 36 moves and an end; both presses count | a start, 37 moves and an end; both presses count |

**Our own app** (Expo SDK 55, expo-video 55.0.21, React Native 0.83.10, Media3 1.8.0), development builds on the same emulator, with a view around the player that counts the `onTouchStart`, `onTouchMove` and `onTouchEnd` it is told of, and a 4-second clip. "Stock" is two builds without the override; the other is built from the same tree with it.

| | stock | with the override |
|---|---|---|
| What JS is told of a drag on the time bar | one touch start, no move, no end (5 of 5) | one touch start, 21 to 27 moves, one end (5 of 5) |
| The clip after the drag | scrubbed | scrubbed |
| The `Pressable`, pressed next | first press ignored, second counts (5 of 5) | first press counts (5 of 5) |
| A horizontal `ScrollView` around the player: a drag along the time bar, against the scroll | the scroll view does not move, the clip is scrubbed | the same |
| …the same drag on the picture | the scroll view scrolls | the same |
| A `ScrollView` with the default `keyboardShouldPersistTaps`, keyboard up: a press on the time bar, then a button outside the scroll view | first press ignored, keyboard stays up | first press counts, keyboard goes away |

The scroll-view rows are why the override passes the request on and does not drop it. The last row was run with our app's own component around `VideoView`, which also answers the start question on the view; the rows above it use a bare `VideoView`.

`VideoView.kt` on `main` ([`868aa663`](https://github.com/expo/expo/blob/868aa663cb2d31581f62a68f4080f25ef1bb0ac4/packages/expo-video/android/src/main/java/expo/modules/video/VideoView.kt#L414-L423), expo-video 58.0.6) has the same hook and no override.

#### Seen while reading, not part of this report

`touchEventCoalescingKeyHelper.addCoalescingKey(event.eventTime)` adds an entry for every event the view reports, keyed by that event's own time, and `TouchEvent` removes an entry only for the event that is an `ACTION_UP` or `ACTION_CANCEL`. So the helper's map gains an entry per touch-down and per move for as long as the view lives.

### Environment

```text
  expo-env-info 2.1.0 environment info:
    System:
      OS: macOS 26.6.2
      Shell: 5.9 - /bin/zsh
    Binaries:
      Node: 22.17.0 - /usr/local/bin/node
      npm: 10.9.2 - /usr/local/bin/npm
    Managers:
      CocoaPods: 1.17.0 - /opt/homebrew/bin/pod
    SDKs:
      iOS SDK:
        Platforms: DriverKit 25.4, iOS 26.4, macOS 26.4, tvOS 26.4, visionOS 26.4, watchOS 26.4
    IDEs:
      Android Studio: 2025.1 AI-251.26094.121.2513.14007798
      Xcode: 26.4/17E192 - /usr/bin/xcodebuild
    npmPackages:
      expo: ~57.0.26 => 57.0.26 
      react: 19.2.3 => 19.2.3 
      react-native: 0.86.3 => 0.86.3 
    npmGlobalPackages:
      eas-cli: 21.2.0
    Expo Workflow: managed
```

Android emulator: Pixel 9a image, API 36 (Android 16), arm64.

### Expo Doctor Diagnostics

```text
Running 21 checks on your project...
21/21 checks passed. No issues detected!
```
