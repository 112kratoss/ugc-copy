'use client';

import { useCallback } from 'react';

const mountedPreviews = new Set<HTMLMediaElement>();

/** User-controlled inline playback: leaving the view pauses, returning never resumes. */
export function useInlineMediaPlayback<T extends HTMLMediaElement>() {
  const attach = useCallback((media: T | null) => {
    if (!media) return;
    mountedPreviews.add(media);
    let isIntersecting: boolean | null = null;
    const pause = () => { if (!media.paused) media.pause(); };
    const inPictureInPicture = () => document.pictureInPictureElement === media;
    const visible = () => {
      const rect = media.getBoundingClientRect();
      return isIntersecting !== false && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth;
    };
    const pauseIfAway = () => {
      // A viewer who explicitly enters picture-in-picture chose background viewing.
      if (!inPictureInPicture() && (document.hidden || !visible())) pause();
    };
    const claimPlayback = () => {
      if (!inPictureInPicture() && (document.hidden || !visible())) {
        pause();
        return;
      }
      for (const other of mountedPreviews) {
        if (other !== media && !other.paused) other.pause();
      }
    };
    media.addEventListener('play', claimPlayback);
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
      media.removeEventListener('leavepictureinpicture', pauseIfAway);
      document.removeEventListener('visibilitychange', pauseIfAway);
      mountedPreviews.delete(media);
      pause();
    };
  }, []);
  return attach;
}
