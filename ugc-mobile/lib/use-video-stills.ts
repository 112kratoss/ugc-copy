import type { VideoThumbnail } from 'expo-video';
import { useEffect, useRef, useState } from 'react';

import { grabVideoFrame, VIDEO_STILLS_READ } from '@/lib/video-frame';

/**
 * A clip a card can draw a still for. `key` names the clip's file apart from
 * the link it is read from (its storage path, where the card has one), so a
 * still stays when the link is renewed; `url` is that link, left out until the
 * card has one.
 */
export type StillClip = { key: string; url: string | null | undefined };

/**
 * The last few stills read, by key, so a card shown again (the reel's Details
 * page mounts and unmounts with its slide) draws its still at once rather than
 * reading its clip again. Each is a bitmap of up to `VIDEO_FRAME_MAX_SIDE` on
 * its longest side, about 1.2 MB, so only a few are kept.
 */
const CACHED_STILLS = 8;
const stillCache = new Map<string, VideoThumbnail>();

function cacheStill(key: string, still: VideoThumbnail) {
  stillCache.delete(key);
  stillCache.set(key, still);
  for (const oldest of stillCache.keys()) {
    if (stillCache.size <= CACHED_STILLS) break;
    stillCache.delete(oldest);
  }
}

function cachedStills(clips: readonly StillClip[]) {
  const stills: Record<string, VideoThumbnail> = {};
  for (const { key } of clips) {
    const still = stillCache.get(key);
    if (still) stills[key] = still;
  }
  return stills;
}

export function resetVideoStillsForTests() {
  stillCache.clear();
}

/**
 * The stills of a row's clips, by key: a still once read, null where the
 * clip's link gave none, nothing while it is unread. React Native has no
 * `<video preload="metadata">` to draw a clip's first frame, so each clip is
 * read for one still (`lib/video-frame.ts`), and only where this binary reads
 * them at all (`VIDEO_STILLS_READ`).
 *
 * - A still stays once read, whatever happens to the link: renewing it to
 *   open the clip keeps the still, and it is not read again.
 * - A clip whose link gave none (it had run out, or the read missed its
 *   deadline) is read again once it has another link, as opening it gives.
 * - Nothing is read while `read` is false (under the mature plate, or with the
 *   reel's Details page off screen): reads under way are called off, and asked
 *   again when it turns true. Stills already read are still returned; whether
 *   one is drawn is the card's call.
 * - A read under way is called off when the row goes, or is hidden (an
 *   <Activity>, Fast Refresh), and asked again when it comes back.
 */
export function useVideoStills(clips: readonly StillClip[], { read = true }: { read?: boolean } = {}) {
  const [stills, setStills] = useState<Record<string, VideoThumbnail | null>>(() => cachedStills(clips));
  // What each finished read gave and the link it read, kept apart from state:
  // a run of the effect that has not seen a still drawn yet must not ask for
  // the clip a second time.
  const landed = useRef(new Map<string, { url: string | null; still: VideoThumbnail | null }>());
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
    for (const { key, url } of clips) {
      const cached = landed.current.get(key)?.still ? undefined : stillCache.get(key);
      if (!cached) continue;
      landed.current.set(key, { url: url ?? null, still: cached });
      setStills((current) => (current[key] === cached ? current : { ...current, [key]: cached }));
    }
    if (!read) {
      for (const request of reading.current.values()) request.abort();
      reading.current.clear();
      return;
    }
    for (const { key, url } of clips) {
      const earlier = landed.current.get(key);
      if (!url || reading.current.has(key) || earlier?.still || earlier?.url === url) continue;

      const request = new AbortController();
      reading.current.set(key, request);
      void grabVideoFrame(url, { signal: request.signal }).then((still) => {
        if (request.signal.aborted) return;
        reading.current.delete(key);
        landed.current.set(key, { url, still });
        if (still) cacheStill(key, still);
        setStills((current) => ({ ...current, [key]: still }));
      });
    }
    // `stills` too: a read that gave none from a link renewed meanwhile is asked again from the new one.
  }, [clips, read, stills]);

  return stills;
}
