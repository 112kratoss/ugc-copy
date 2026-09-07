import { useContext, useEffect, useRef } from 'react';
import { AppState, Dimensions, Platform, View } from 'react-native';
import type { VideoPlayer } from 'expo-video';
import { MediaViewportContext } from '@/components/media-viewport-scroll-view';
import { nativePreviewPlaybackOwner, previewIntersectsViewport, type PreviewRect } from './native-preview-playback';

export function useNativePreviewPlayback(player: VideoPlayer, isFocused: boolean) {
  const viewRef = useRef<View>(null);
  const viewport = useContext(MediaViewportContext);
  const fullscreen = useRef(false);
  const checkRef = useRef(() => {});
  useEffect(() => {
    let active = true;
    let measuring = false;
    let rerun = false;
    const pause = () => { if (active) player.pause(); };
    const check = () => {
      if (!active || !player.playing) return;
      if (!isFocused || (AppState.currentState && AppState.currentState !== 'active')) { pause(); return; }
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
      if (!isFocused || (AppState.currentState && AppState.currentState !== 'active')) { pause(); return; }
      nativePreviewPlaybackOwner.claim(player);
      check();
    };
    const playing = player.addListener('playingChange', event => {
      if (event.isPlaying) claim();
      else nativePreviewPlaybackOwner.release(player);
    });
    const background = AppState.addEventListener('change', state => { if (state !== 'active') pause(); });
    const blur = Platform.OS === 'android' ? AppState.addEventListener('blur', pause) : null;
    const unsubscribe = viewport?.subscribe(check);
    const dimensions = Dimensions.addEventListener('change', check);
    if (player.playing) claim();
    return () => {
      active = false;
      playing.remove(); background.remove(); blur?.remove(); dimensions.remove(); unsubscribe?.();
      nativePreviewPlaybackOwner.release(player);
    };
  }, [isFocused, player, viewport]);
  return { viewRef, onLayout: () => checkRef.current(),
    onFullscreenEnter: () => { fullscreen.current = true; },
    onFullscreenExit: () => { fullscreen.current = false; checkRef.current(); },
  };
}
