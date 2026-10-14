import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { logBackendWarning } from '@/lib/backend-logger';
import { toStorageUploadBody } from '@/lib/storage-upload-body';

/**
 * Profile images are the only user media the product served at whatever size
 * it was given.
 *
 * The `profiles` bucket holds avatars from 9.5 KB to 1.63 MB and covers to
 * 1.77 MB, because the upload path only ever capped total bytes (5 MB) and
 * never dimensions. Mobile renders `avatar_url` directly, so a creator card
 * fetched a 1.6 MB PNG to fill a 48pt circle; web at least routes through
 * `next/image`.
 *
 * No `server-only` marker here, deliberately: the backfill script imports this
 * module directly, and that import specifier only resolves inside Next, so the
 * marker made `npm run backfill:profile-image-dimensions` fail to start. The
 * guard is kept where it belongs — `profile-route-service.ts`, the only caller
 * in the app, carries it — and `sharp` could not be bundled for a client
 * anyway. `media-display-rendition.ts` is unmarked for the same reason.
 *
 * Normalising happens on the server, when the profile is saved, rather than in
 * the clients. A client-side resize on mobile would need `expo-image-manipulator`,
 * a native module — which moves the runtime fingerprint and so cannot reach any
 * installed build over the air. Doing it here fixes both platforms at once, and
 * the next store build owes nothing.
 */
export const PROFILE_IMAGE_MAX_EDGE = {
  // A 512px avatar covers a 96pt circle at 3x with room to spare.
  avatar: 512,
  // Covers span the full width of a phone; 1600px covers a 3x screen.
  cover: 1600,
} as const;

export type ProfileImageRole = keyof typeof PROFILE_IMAGE_MAX_EDGE;

/**
 * Every screen draws a cover as a wide strip, and the web editor frames it at
 * 1600×360 (40:9). The iOS picker can only crop square, so the app sends the
 * whole photo, and a cover of any other shape is cut to this frame here, from
 * its centre: the part a cover fit shows anyway.
 */
export const PROFILE_COVER_SIZE = { width: 1600, height: 360 } as const;

/**
 * The 40:9 frame for a cover of this upright size: 1600×360, or the largest
 * 40:9 rectangle a smaller picture holds, so a cover is never enlarged.
 */
export function getProfileCoverFrame(width: number, height: number): { width: number; height: number } {
  const frameWidth = Math.max(1, Math.min(
    PROFILE_COVER_SIZE.width,
    width,
    Math.floor((height * PROFILE_COVER_SIZE.width) / PROFILE_COVER_SIZE.height),
  ));
  return {
    width: frameWidth,
    height: Math.max(1, Math.round((frameWidth * PROFILE_COVER_SIZE.height) / PROFILE_COVER_SIZE.width)),
  };
}

/**
 * The role is read from the object name, which the signing route mints as
 * `<userId>/<role>-<uploadId>-<fileName>`. Anything else is left alone rather
 * than guessed at.
 */
export function getProfileImageRole(filePath: string): ProfileImageRole | null {
  const name = filePath.split('/').pop() ?? '';
  if (name.startsWith('avatar-')) return 'avatar';
  if (name.startsWith('cover-')) return 'cover';
  return null;
}

/**
 * Resizes a freshly uploaded profile image in place when it is larger than its
 * role needs, and cuts a cover to its 40:9 frame.
 *
 * In place, at the same path, on purpose: the URL the client just received
 * stays correct, no column has to be rewritten, and no superseded object is
 * orphaned in a public bucket. The object is seconds old, so nothing has cached
 * it yet.
 *
 * Returns whether it rewrote the object. A failure is reported as `false` and
 * logged, never thrown: the profile save that triggered this must not fail
 * because a resize did, and the original is a correct if oversized image.
 * Storage refuses the rewrite once an upload has been finalized (finalizing
 * tombstones its path; `profile-media-postgrest.test.ts` pins it), so for
 * those uploads this is a logged no-op.
 */
export async function normalizeStoredProfileImage({
  adminSupabase,
  bucket,
  filePath,
}: {
  adminSupabase: SupabaseClient;
  bucket: string;
  filePath: string;
}): Promise<boolean> {
  const role = getProfileImageRole(filePath);
  if (!role) return false;
  const maxEdge = PROFILE_IMAGE_MAX_EDGE[role];

  try {
    const storage = adminSupabase.storage.from(bucket);
    const download = await storage.download(filePath);
    if (download.error || !download.data) return false;

    const input = Buffer.from(await download.data.arrayBuffer());
    const image = sharp(input).rotate();
    const metadata = await image.metadata();
    // Upright: a phone photo often stores its pixels a quarter turn round.
    const { width, height } = metadata.autoOrient;
    const longestEdge = Math.max(width, height);
    const coverFrame = role === 'cover' && width > 0 && height > 0
      ? getProfileCoverFrame(width, height)
      : null;
    const reframe = coverFrame !== null && (coverFrame.width !== width || coverFrame.height !== height);
    // Already within its role's size and shape, and not carrying needless bytes.
    if (!reframe && longestEdge > 0 && longestEdge <= maxEdge && input.byteLength <= 300_000) {
      return false;
    }

    const resized = await image
      .resize(coverFrame
        ? { ...coverFrame, fit: 'cover', position: 'centre' }
        : { width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();

    // Only replace what is genuinely smaller; a tiny hand-tuned avatar should
    // keep its own bytes rather than be re-encoded for nothing. A cover cut to
    // a new frame replaces its original whatever the bytes.
    if (!reframe && resized.byteLength >= input.byteLength) return false;

    const upload = await storage.upload(filePath, toStorageUploadBody(resized, 'image/webp'), {
      contentType: 'image/webp',
      upsert: true,
      cacheControl: '3600',
    });
    if (upload.error) throw upload.error;
    return true;
  } catch (error) {
    logBackendWarning('failed_to_normalize_profile_image', { error });
    return false;
  }
}
