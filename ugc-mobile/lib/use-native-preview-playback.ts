import { useContext, useEffect, useRef } from 'react';
import { AppState, Dimensions, Platform, View } from 'react-native';
import type { VideoPlayer } from 'expo-video';
import { MediaViewportContext } from '@/components/media-viewport-scroll-view';
import { useInModalWindow } from './modal-window';
import { nativePreviewPlaybackOwner, previewIntersectsViewport, type PreviewRect } from './native-preview-playback';

/** How long a clip may wait for data behind its fullscreen player and still go on by itself. */
const LONG_WAIT_MS = 2000;

export function useNativePreviewPlayback(player: VideoPlayer, isFocused: boolean) {
  const viewRef = useRef<View>(null);
  const viewport = useContext(MediaViewportContext);
  const inModalWindow = useInModalWindow();
  const fullscreen = useRef(false);
  // Android: this clip's fullscreen player is in front of the app. expo-video
  // shows it in an activity of its own, so the app's activity is paused under
  // it: `AppState` says `background` and the window has lost the focus, while
  // the clip is the one thing on screen. True from the view's onFullscreenEnter
  // until the app's activity is in front again.
  const behindFullscreen = useRef(false);
  const checkRef = useRef(() => {});
  useEffect(() => {
    let active = true;
    let measuring = false;
    let rerun = false;
    const pause = () => { if (active) player.pause(); };
    const away = () => !!AppState.currentState && AppState.currentState !== 'active' && !behindFullscreen.current;
    const check = () => {
      if (!active || !player.playing) return;
      if (!isFocused || away()) { pause(); return; }
      if (fullscreen.current || !viewRef.current) return;
      if (measuring) { rerun = true; return; }
      measuring = true;
      const measure = (bounds: PreviewRect) => {
        if (!active || !viewRef.current) { measuring = false; return; }
        viewRef.current.measureInWindow((x, y, width, height) => {
          measuring = false;
          if (!active) return;
          if (!fullscreen.current && !previewIntersectsViewport({ x, y, width, height }, bounds)) pause();
          if (rerun) { rerun = false; check(); }
        });
      };
      if (viewport) viewport.measure(measure);
      else { const window = Dimensions.get('window'); measure({ x: 0, y: 0, width: window.width, height: window.height }); }
    };
    checkRef.current = check;
    const claim = () => {
      if (!active) return;
      if (!isFocused || away()) { pause(); return; }
      nativePreviewPlaybackOwner.claim(player);
      check();
    };
    // Android: nothing tells JS that the app was left while the fullscreen
    // player was in front, because its own activity was paused already.
    // expo-video stops the clip then only if it is playing at that moment
    // (FullscreenPlayerActivity.onPause), so a clip that wants to play and is
    // waiting for data starts when the data comes, behind the launcher or the
    // lock screen. So there a clip that has waited long is not started by its
    // data: it waits for a press. After a short wait, as a seek makes, it
    // plays on.
    let waitingSince: number | null = null;
    const waitedLongUnseen = () => behindFullscreen.current && waitingSince !== null && Date.now() - waitingSince > LONG_WAIT_MS;
    const playing = player.addListener('playingChange', event => {
      if (!event.isPlaying) {
        waitingSince = player.status === 'loading' ? Date.now() : null;
        nativePreviewPlaybackOwner.release(player);
        return;
      }
      const unseen = waitedLongUnseen();
      waitingSince = null;
      if (unseen) pause();
      else claim();
    });
    const status = player.addListener('statusChange', event => {
      if (event.status !== 'readyToPlay' || !waitedLongUnseen()) return;
      waitingSince = null;
      pause();
    });
    const background = AppState.addEventListener('change', state => {
      if (state === 'active') { behindFullscreen.current = false; return; }
      if (behindFullscreen.current) return;
      // Android's activity pauses as the fullscreen player opens, too, and JS
      // can hear of that before the view's onFullscreenEnter, which waits for
      // the next frame. expo-video acts on the same pause and knows which it
      // is: it stops every playing clip but one going into fullscreen
      // (VideoManager.onAppBackgrounded). So a clip still playing here is that
      // one, or is being stopped already. Unless fullscreen has just closed:
      // until its activity is destroyed expo-video still counts the view as in
      // fullscreen, and would leave the clip playing as the app goes away.
      if (Platform.OS === 'android' && player.playing && !fullscreen.current) return;
      pause();
    });
    // Android: the activity's window lost the focus, so something has come
    // over the page: the notification shade, a system dialog, a Modal of the
    // app. A preview inside a Modal is in that Modal's window, not on the
    // page, and the blur it hears is its own Modal opening: pausing on it
    // took back the lightbox clip's request to play (see ModalWindowScope).
    const blur = Platform.OS === 'android' && !inModalWindow ? AppState.addEventListener('blur', () => { if (!behindFullscreen.current) pause(); }) : null;
    const unsubscribe = viewport?.subscribe(check);
    const dimensions = Dimensions.addEventListener('change', check);
    if (player.playing) claim();
    return () => {
      active = false;
      playing.remove(); status.remove(); background.remove(); blur?.remove(); dimensions.remove(); unsubscribe?.();
      nativePreviewPlaybackOwner.release(player);
    };
  }, [inModalWindow, isFocused, player, viewport]);
  return { viewRef, onLayout: () => checkRef.current(),
    onFullscreenEnter: () => { fullscreen.current = true; behindFullscreen.current = Platform.OS === 'android'; },
    onFullscreenExit: () => { fullscreen.current = false; behindFullscreen.current = false; checkRef.current(); },
  };
}
