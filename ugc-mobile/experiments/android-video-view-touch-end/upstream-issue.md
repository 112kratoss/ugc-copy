<!--
A draft for expo/expo, written 2026-10-05. NOT posted: the owner sends it.

Before sending:
- The bug form asks for a link to a minimal reproduction (a repository or a Snack). The App.tsx
  below is the whole of one: `npx create-expo-app@latest --template blank-typescript`, then
  `npx expo install expo-video`, paste it, and build for Android (`npx expo run:android`).
- The form also asks for `npx expo-env-info` and `npx expo-doctor` output from that project.
- Everything under "What we observed" was seen in this app's dev client with an instrumented copy
  of the reproduction, not in a fresh project. The text says so; running the fresh project once
  before sending would let you drop that caveat.
- Evidence behind the table: archive/android-video-view-touch-end-2026-10-05/ at the workspace level.
-->

**Title:** [expo-video][Android] With `nativeControls`, a touch on the time bar reaches JS as a start with no end, and the next press anywhere is ignored

### Summary

On Android, a `VideoView` with `nativeControls` tells React Native when a touch on it starts. If the touch lands on the player's time bar (a scrub, or a press with no drag), it never tells React Native that the touch ended.

JS is left with a touch that is in progress forever. Whichever view became the JS responder when that touch started keeps the responder, React Native routes the next touch to it instead of to the view under the finger, and that touch is lost. Its end finally releases the responder, so the touch after it works.

What a person sees: scrub the video, press a button, nothing happens. Press again and it works.

### Minimal reproduction

```tsx
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Button, Modal, Pressable, Text, View } from 'react-native';

const source = 'https://d23dyxeqlo5psv.cloudfront.net/big_buck_bunny.mp4';

export default function App() {
  const player = useVideoPlayer(source);
  const [open, setOpen] = useState(false);
  const [presses, setPresses] = useState(0);

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <Button title="Open" onPress={() => setOpen(true)} />
      <Modal visible={open} onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 24 }}>
          <VideoView player={player} nativeControls style={{ height: 300 }} />
          <Pressable onPress={() => setPresses((n) => n + 1)} style={{ padding: 16, backgroundColor: '#ddd' }}>
            <Text>Pressed {presses} time(s)</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}
```

1. Run it on Android and press **Open**.
2. Wait for the clip to load, then drag the player's time bar. A press on the bar with no drag does the same.
3. Press **Pressed 0 time(s)**.

**Expected:** the count goes to 1.
**Actual:** the first press does nothing. The second counts.

The `Modal` is only there to make the stale responder visible: React Native's `Modal` answers `onStartShouldSetResponder` with `true` for every touch-down that reaches it ([`Modal.js`](https://github.com/facebook/react-native/blob/v0.83.10/packages/react-native/Libraries/Modal/Modal.js#L343)), so it becomes the responder when the touch starts and is never released. Any ancestor that takes touch-downs shows it the same way, for example a `ScrollView` with `keyboardShouldPersistTaps="handled"` while the keyboard is up, or a `ScrollView` that is still decelerating (it claims in the capture phase, so the app cannot get in ahead of it).

### Cause

1. With `nativeControls` the view reports touches to JS from `onInterceptTouchEvent` ([`VideoView.kt`](https://github.com/expo/expo/blob/d50bac42ff61d70fba771efd7056f09565f86b03/packages/expo-video/android/src/main/java/expo/modules/video/VideoView.kt#L414-L423)):

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
3. Media3's time bar sets that flag on all of its ancestors as soon as a touch lands on it: `DefaultTimeBar.onTouchEvent` calls `startScrubbing` on `ACTION_DOWN`, which calls `getParent().requestDisallowInterceptTouchEvent(true)` ([`DefaultTimeBar.java`](https://github.com/androidx/media/blob/1.8.0/libraries/ui/src/main/java/androidx/media3/ui/DefaultTimeBar.java#L796-L803)). `ViewGroup.requestDisallowInterceptTouchEvent` records it on each ancestor on the way up, `VideoView` included. In media3-ui 1.8.0 the time bar is the only class that makes this request.
4. So for that gesture the hook runs for `ACTION_DOWN` (the view sees it before the time bar does) and for nothing after. JS receives `topTouchStart` and no `topTouchMove` or `topTouchEnd`.
5. React's responder system releases the responder on a touch end with no touches left, which never arrives. Its count of touches in progress (`trackedTouchCount`) also stays one too high after every such touch.

### Proposed change

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
- React Native's root views do the same, for the same reason: [`ReactRootView.requestDisallowInterceptTouchEvent`](https://github.com/facebook/react-native/blob/v0.83.10/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java#L414-L420) and [`ReactSurfaceView`](https://github.com/facebook/react-native/blob/v0.83.10/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactSurfaceView.kt#L115-L119) ("Override in order to still receive events to onInterceptTouchEvent even when some other views disallow that, but propagate it up the tree if possible").

An alternative with the same effect would be to report from `dispatchTouchEvent`, which Android calls for every event whatever the flag says. I have not tried that one.

### What we observed

On an Android emulator (Pixel 9a, API 36), in development builds of our app, with an instrumented copy of the reproduction above: the same `VideoView` with `nativeControls` in a `Modal` beside a `Pressable`, a view around the player that counts the `onTouchStart`, `onTouchMove` and `onTouchEnd` it is told of, and a 4-second clip. "Stock" is two builds without the override: the development build that was already on the emulator, and one built from the same tree as the build with the override. Those last two were each checked for the method in their dex. Presses were sent with `adb shell input swipe x y x y 120`, which carries move events as a finger does (`input tap` sends none).

| | stock | with the override |
|---|---|---|
| What JS is told of a drag on the time bar | one touch start, no move, no end (5 of 5) | one touch start, 21 to 27 moves, one end (5 of 5) |
| The clip after the drag | scrubbed | scrubbed |
| The `Pressable`, pressed next | first press ignored, second counts (5 of 5) | first press counts (5 of 5) |
| A press on the time bar with no drag, then the `Pressable` | first press ignored (1 of 1) | first press counts (1 of 1) |
| A horizontal `ScrollView` around the player: a drag along the time bar, against the scroll | the scroll view does not move, the clip is scrubbed | the same |
| …the same drag on the picture | the scroll view scrolls | the same |
| A `ScrollView` with the default `keyboardShouldPersistTaps`, keyboard up: a press on the time bar, then a button outside the scroll view | first press ignored, keyboard stays up | first press counts, keyboard goes away |

The scroll-view rows are why the override passes the request on and does not drop it. The last row was run with our app's own component around `VideoView`, which also answers the start question on the view; the rows above it use a bare `VideoView`.

### Environment

- expo-video 55.0.21 (Expo SDK 55), React Native 0.83.10 with the new architecture, Media3 1.8.0.
- Android emulator, Pixel 9a, API 36.
- `VideoView.kt` on `main` (`d50bac42`, expo-video 58.0.6) has the same hook and no override, so I expect the same there. I have not run it.

### Seen while reading, not part of this report

`touchEventCoalescingKeyHelper.addCoalescingKey(event.eventTime)` adds an entry for every event the view reports, keyed by that event's own time, and `TouchEvent` removes an entry only for the event that is an `ACTION_UP` or `ACTION_CANCEL`. So the helper's map gains an entry per touch-down and per move for as long as the view lives.
