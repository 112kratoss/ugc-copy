import type { VideoThumbnail } from 'expo-video';
import { useEffect, useRef, useState } from 'react';

import { grabVideoFrame, VIDEO_STILLS_READ } from '@/lib/video-frame';
import { cachedVideoStill, cacheVideoStill } from '@/lib/video-still-cache';

/**
 * A clip a card can draw a still for. `key` names the clip's file apart from
 * the link it is read from (its storage path, where the card has one), so a
 * still stays when the link is renewed; `url` is that link, left out until the
 * card has one.
 */
export type StillClip = { key: string; url: string | null | undefined };

function cachedStills(clips: readonly StillClip[]) {
  const stills: Record<string, VideoThumbnail> = {};
  for (const { key } of clips) {
    const still = cachedVideoStill(key);
    if (still) stills[key] = still;
  }
  return stills;
}

/**
 * The stills of a row's clips, by key (`stills`: a still once read, null where
 * the clip's read gave none, nothing while it is unread), and `readAgain`,
 * which a card calls when it opens its clip. React Native has no
 * `<video preload="metadata">` to draw a clip's first frame, so each clip is
 * read for one still (`lib/video-frame.ts`), and only where this binary reads
 * them at all (`VIDEO_STILLS_READ`).
 *
 * - Each file is read once per mount, from the first link given for it, and
 *   a still read on an earlier visit, or by another row, is drawn from
 *   `lib/video-still-cache.ts` without a read. A still stays whatever happens
 *   to the link.
 * - A clip whose read gave none is read again only once its card opens it
 *   (`readAgain`), from the link the open renewed: a record read again for any
 *   other reason renews every link, and every clip that missed would be read
 *   at once on what may well be a slow link.
 * - Nothing is read while `read` is false (under the mature plate, or with the
 *   reel's Details page off screen): reads under way are called off, and asked
 *   again when it turns true. Stills already read are still returned; whether
 *   one is drawn is the card's call.
 * - A read under way is called off when the row goes, or is hidden (an
 *   <Activity>, Fast Refresh), and asked again when it comes back.
 */
export function useVideoStills(clips: readonly StillClip[], { read = true }: { read?: boolean } = {}) {
  const [stills, setStills] = useState<Record<string, VideoThumbnail | null>>(() => cachedStills(clips));
  // What each finished read gave, kept apart from state: a run of the effect
  // that has not seen a still drawn yet must not ask for the clip a second time.
  const landed = useRef(new Map<string, VideoThumbnail | null>());
  const reading = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const requests = reading.current;
    return () => {
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, []);

  useEffect(() => {
    if (!VIDEO_STILLS_READ) return;
    for (const { key } of clips) {
      if (landed.current.get(key)) continue;
      const cached = cachedVideoStill(key);
      if (!cached) continue;
      landed.current.set(key, cached);
      setStills((current) => (current[key] === cached ? current : { ...current, [key]: cached }));
    }
    if (!read) {
      for (const request of reading.current.values()) request.abort();
      reading.current.clear();
      return;
    }
    // A file is read once, whatever links its cards give it: one read under
    // way, or landed with or without a still, is enough until `readAgain`.
    for (const { key, url } of clips) {
      if (!url || reading.current.has(key) || landed.current.has(key)) continue;

      const request = new AbortController();
      reading.current.set(key, request);
      // A file another row is reading too is read once: whichever read comes
      // second in the queue takes the first one's still instead.
      void grabVideoFrame(url, { signal: request.signal, alreadyRead: () => cachedVideoStill(key) }).then((frame) => {
        if (request.signal.aborted) return;
        reading.current.delete(key);
        const still = frame ?? cachedVideoStill(key) ?? null;
        if (still) cacheVideoStill(key, still);
        landed.current.set(key, still);
        setStills((current) => (current[key] === still && key in current ? current : { ...current, [key]: still }));
      });
    }
    // `stills` too: asking again for a clip clears its entry, which runs this.
  }, [clips, read, stills]);

  /** Asks again for a clip whose read gave no still, from the link it has now. */
  const readAgain = (key: string) => {
    if (landed.current.get(key) !== null) return;
    landed.current.delete(key);
    setStills((current) => {
      if (current[key] !== null) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  return { stills, readAgain };
}
