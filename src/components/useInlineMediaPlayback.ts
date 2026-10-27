'use client';

import { useCallback, type RefObject } from 'react';

/** Every attached preview, with whether it is on screen right now. */
const mountedPreviews = new Map<HTMLMediaElement, { onScreen: () => boolean }>();
/**
 * Previews another's start paused while they were playing, the one paused last
 * at the end. Once nothing plays, the last of them still on screen and still
 * set to autoplay plays again: a Home shelf clip that started over the feed's
 * first clip hands the page back to it once the shelf has scrolled away. One
 * that has left the view meanwhile is dropped (returning never resumes), and
 * so is one its owner no longer autoplays, or one the viewer started by hand.
 */
const waiting: HTMLMediaElement[] = [];
/**
 * How long a stop waits for the next start before it hands back: the shelf and
 * the feed's carousels swap one preview for the next by unmounting the first,
 * and the next starts a frame or two later.
 */
export const INLINE_MEDIA_HAND_BACK_DELAY_MS = 300;
let handBackTimer: ReturnType<typeof setTimeout> | null = null;

function forget(media: HTMLMediaElement) {
  const index = waiting.indexOf(media);
  if (index !== -1) waiting.splice(index, 1);
}

function handBackSoon() {
  if (handBackTimer !== null) clearTimeout(handBackTimer);
  handBackTimer = setTimeout(() => {
    handBackTimer = null;
    if ([...mountedPreviews.keys()].some((media) => !media.paused)) return;
    if (document.hidden) {
      waiting.length = 0;
      return;
    }
    for (let media = waiting.pop(); media; media = waiting.pop()) {
      if (!media.paused || !media.autoplay || !mountedPreviews.get(media)?.onScreen()) continue;
      try {
        void media.play()?.catch(() => {});
      } catch {
        // A preview the browser will not start again simply stays paused.
      }
      return;
    }
  }, INLINE_MEDIA_HAND_BACK_DELAY_MS);
}

/**
 * User-controlled inline playback: leaving the view pauses, returning never
 * resumes. One preview plays at a time: the one that starts pauses the
 * others, and once it stops the last autoplaying one it paused in view plays
 * again (`waiting`).
 */
export function useInlineMediaPlayback<T extends HTMLMediaElement>(elementRef?: RefObject<T | null>) {
  const attach = useCallback((media: T | null) => {
    if (elementRef) elementRef.current = media;
    if (!media) return;
    let isIntersecting: boolean | null = null;
    const pause = () => { if (!media.paused) media.pause(); };
    const inPictureInPicture = () => document.pictureInPictureElement === media;
    const visible = () => {
      const rect = media.getBoundingClientRect();
      return isIntersecting !== false && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth;
    };
    mountedPreviews.set(media, { onScreen: visible });
    const pauseIfAway = () => {
      // A viewer who explicitly enters picture-in-picture chose background viewing.
      if (!inPictureInPicture() && (document.hidden || !visible())) pause();
    };
    const claimPlayback = () => {
      if (!inPictureInPicture() && (document.hidden || !visible())) {
        pause();
        return;
      }
      forget(media);
      for (const other of mountedPreviews.keys()) {
        if (other === media || other.paused) continue;
        forget(other);
        waiting.push(other);
        other.pause();
      }
    };
    // A preview another's start paused waits for that one to stop instead.
    const handBackOnStop = () => {
      if (!waiting.includes(media)) handBackSoon();
    };
    media.addEventListener('play', claimPlayback);
    media.addEventListener('pause', handBackOnStop);
    media.addEventListener('leavepictureinpicture', pauseIfAway);
    document.addEventListener('visibilitychange', pauseIfAway);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      for (const entry of entries) {
        isIntersecting = entry.isIntersecting;
        if (!entry.isIntersecting && !inPictureInPicture()) pause();
      }
    });
    observer?.observe(media);
    if (!media.paused) claimPlayback();
    return () => {
      observer?.disconnect();
      media.removeEventListener('play', claimPlayback);
      media.removeEventListener('pause', handBackOnStop);
      media.removeEventListener('leavepictureinpicture', pauseIfAway);
      document.removeEventListener('visibilitychange', pauseIfAway);
      if (elementRef?.current === media) elementRef.current = null;
      mountedPreviews.delete(media);
      forget(media);
      pause();
      // Whether or not it still played: one paused as it left the view and
      // dropped in the same moment says so only after this listener has gone.
      if (waiting.length) handBackSoon();
    };
  }, [elementRef]);
  return attach;
}
