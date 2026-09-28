# Media zoom return verification — 2026-09-28

Status: fixed and verified locally; not published.

## Problem and change

Returning from the media viewer to Profile → Saved could jump from the playing video to its poster. Browsing to another post also needed its destination tile prepared before returning. The custom background veil used elapsed time during interactive dismissal, so it could disagree with a slow or cancelled native gesture.

The iOS viewer now gives its player to the Saved tile on return. The tile holds the closing frame and can lend the player back on reopening. Player ownership survives dismissal, cancellation and rapid reopening; ordinary viewer cleanup still releases unused players. Saved remains a poster grid until a video is returned to it.

The Saved grid reveals the current post's tile when the viewer retargets its return. Interactive veil opacity follows the native transition's closing progress. Back-button dismissal retains its timed fallback because React can remove the viewer before the native pop completes.

## Platform choice

Apple's native zoom remains responsible for opening and closing. The existing Expo Router zoom source and target integration was retained. The installed Expo Router and react-native-screens bindings were inspected; react-native-screens exposes native transition progress through `useTransitionProgress`, which supplies the veil animation without a replacement gesture recognizer.

The native zoom path requires the existing supported iOS runtime (iOS 18+). Older iOS retains the existing fade fallback, and Android retains its existing transition and player lifetime. No native dependencies were changed. Release compatibility was not certified in this task.

## Verification

- iPhone 17 Pro simulator, iOS 26.4: opening, Back dismissal, retained video frame in Saved, and reopening were exercised against the updated local bundle.
- The user manually tested the updated close interaction and reported “its smooth now” after being asked to exercise slow dismissal, cancellation and browsing before closing. Automated simulator drags were not reliable enough to independently certify each gesture case.
- Mobile suite: 275 test files, 2,698 tests passed. Added coverage for return-target preparation, player ownership, cancellation, Strict Mode, source replacement and rapid reopening.
- Mobile TypeScript check and `git diff --check` passed.

The Saved destination preparation was verified here; this report does not certify offscreen return behavior for every other feed surface or physical devices.

## Opening follow-up

The user subsequently reported a white background/overlay while opening. Simulator recordings showed a light rectangular rim around the pressed tile before expansion, then a light edge in the native source snapshot. The rectangular veil opening exposed the grid around the rounded tile, and press scaling changed the visible tile size after measurement.

The veil now uses a rounded cutout with the source tile's radius. Native Saved zooms keep the source at its laid-out size instead of running a competing press-scale animation. The registered native source has an opaque black background and clips to its rounded bounds. Saved tiles also omit their ordinary light border on this path, preventing UIKit from enlarging it into a bright outline. Apple still owns the zoom animation; dismissal progress and player handoff are unchanged.

Frame-by-frame simulator review confirmed removal of the rectangular white rim and the bright snapshot edge. Both video and image opening/Back cycles were exercised during the follow-up. This remains local simulator verification, not a physical-device or release certification.
