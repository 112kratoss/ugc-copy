import type { VideoThumbnail } from 'expo-video';

/**
 * The last few clip stills read (`lib/use-video-stills.ts`), by the clip's
 * file, so a card shown again (the reel's Details page mounts and unmounts
 * with its slide) draws its still at once rather than reading its clip again.
 * Each is a bitmap of up to `VIDEO_FRAME_MAX_SIDE` on its longest side, about
 * 1.2 MB, so only a few are kept, the least recently drawn going first.
 *
 * A module of its own with nothing native in it, so the sign-out can clear it
 * (`lib/auth.tsx`) without loading the player.
 */
const CACHED_STILLS = 8;
const stills = new Map<string, VideoThumbnail>();
/** How many times the cache was cleared: a still read across a clear belongs to a session that has left. */
let clears = 0;

/** What a read hands back to `cacheVideoStill` with its still: taken as the read starts. */
export function videoStillClears() {
  return clears;
}

/** The still kept for `key`, which then counts as the most recently drawn. */
export function cachedVideoStill(key: string) {
  const still = stills.get(key);
  if (still) {
    stills.delete(key);
    stills.set(key, still);
  }
  return still;
}

export function cacheVideoStill(key: string, still: VideoThumbnail, clearsWhenRead = clears) {
  // Begun before a sign-out cleared the cache: not the next person's to draw.
  if (clearsWhenRead !== clears) return;
  stills.delete(key);
  stills.set(key, still);
  for (const oldest of stills.keys()) {
    if (stills.size <= CACHED_STILLS) break;
    stills.delete(oldest);
  }
}

/** On every way a session leaves the phone: the stills are of that person's clips. Between tests too. */
export function clearVideoStills() {
  clears += 1;
  stills.clear();
}
