'use client';

import { useCallback, type ComponentPropsWithoutRef } from 'react';

const mountedPreviews = new Set<HTMLVideoElement>();

/** User-controlled inline playback: leaving the view pauses, returning never resumes. */
export default function InlineMediaVideo(props: ComponentPropsWithoutRef<'video'>) {
  const attach = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    mountedPreviews.add(video);
    let isIntersecting: boolean | null = null;
    const pause = () => { if (!video.paused) video.pause(); };
    const inPictureInPicture = () => document.pictureInPictureElement === video;
    const visible = () => {
      const rect = video.getBoundingClientRect();
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
        if (other !== video && !other.paused) other.pause();
      }
    };
    video.addEventListener('play', claimPlayback);
    video.addEventListener('leavepictureinpicture', pauseIfAway);
    document.addEventListener('visibilitychange', pauseIfAway);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      for (const entry of entries) {
        isIntersecting = entry.isIntersecting;
        if (!entry.isIntersecting && !inPictureInPicture()) pause();
      }
    });
    observer?.observe(video);
    if (!video.paused) claimPlayback();
    return () => {
      observer?.disconnect();
      video.removeEventListener('play', claimPlayback);
      video.removeEventListener('leavepictureinpicture', pauseIfAway);
      document.removeEventListener('visibilitychange', pauseIfAway);
      mountedPreviews.delete(video);
      pause();
    };
  }, []);
  return <video {...props} ref={attach} />;
}
