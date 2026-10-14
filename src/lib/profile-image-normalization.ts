import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { logBackendWarning } from '@/lib/backend-logger';
import { assertStoredPreviewIsIntact } from '@/lib/media-preview-integrity';
import { getMediaContentHash } from '@/lib/media-preview-metadata';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';
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

const PROFILE_IMAGE_BUCKET = 'profiles';

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

const NORMALIZED_PROFILE_IMAGE_NAME = /\.normalized\.[0-9a-f]{16}\.webp$/;

/**
 * Where the normalised copy of a profile upload lives: beside it, as
 * `<name without extension>.normalized.<content hash>.webp`.
 *
 * The signing route mints names with exactly one dot, so no upload capability
 * can ever be issued for one of these paths. The hash makes the name say what
 * the bytes are, so writing the copy again writes the same picture, and a
 * cached copy can never go stale under its URL.
 */
export function buildNormalizedProfileImagePath(filePath: string, contentHash: string): string {
  const extensionIndex = filePath.lastIndexOf('.');
  const basePath = extensionIndex > filePath.lastIndexOf('/')
    ? filePath.slice(0, extensionIndex)
    : filePath;
  return `${basePath}.normalized.${contentHash}.webp`;
}

export function isNormalizedProfileImagePath(filePath: string): boolean {
  return NORMALIZED_PROFILE_IMAGE_NAME.test(filePath.split('/').pop() ?? '');
}

const PUBLIC_PROFILE_OBJECT_PREFIX = `/storage/v1/object/public/${PROFILE_IMAGE_BUCKET}/`;

/**
 * The public URL of `filePath`, spelled on the origin of the URL the client
 * sent, so the profile's host rules accept it when the client sends it back.
 * Null when the source is not a public profile URL, or when the result would
 * not parse back to exactly this path and owner.
 */
export function buildProfileImagePublicUrl(sourceUrl: string, filePath: string): string | null {
  const prefixIndex = sourceUrl.indexOf(PUBLIC_PROFILE_OBJECT_PREFIX);
  if (prefixIndex < 0) return null;
  const url = sourceUrl.slice(0, prefixIndex + PUBLIC_PROFILE_OBJECT_PREFIX.length)
    + filePath.split('/').map(encodeURIComponent).join('/');
  const location = getUserOwnedStoredMediaLocation(url, filePath.split('/')[0] ?? '');
  return location?.bucket === PROFILE_IMAGE_BUCKET && location.filePath === filePath ? url : null;
}

/**
 * The WebP a profile image should be stored as, or null when it is already
 * right for its role: within its size, in its frame, and not carrying needless
 * bytes. A cover cut to a new frame always gets one; anything else only when
 * the result is genuinely smaller, so a tiny hand-tuned avatar keeps its own
 * bytes rather than be re-encoded for nothing.
 */
async function encodeNormalizedProfileImage(input: Buffer, role: ProfileImageRole): Promise<Buffer | null> {
  const maxEdge = PROFILE_IMAGE_MAX_EDGE[role];
  const image = sharp(input).rotate();
  const metadata = await image.metadata();
  // Upright: a phone photo often stores its pixels a quarter turn round.
  const { width, height } = metadata.autoOrient;
  const longestEdge = Math.max(width, height);
  const coverFrame = role === 'cover' && width > 0 && height > 0
    ? getProfileCoverFrame(width, height)
    : null;
  const reframe = coverFrame !== null && (coverFrame.width !== width || coverFrame.height !== height);
  if (!reframe && longestEdge > 0 && longestEdge <= maxEdge && input.byteLength <= 300_000) {
    return null;
  }

  const resized = await image
    .resize(coverFrame
      ? { ...coverFrame, fit: 'cover', position: 'centre' }
      : { width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  if (!reframe && resized.byteLength >= input.byteLength) return null;
  return resized;
}

/**
 * Writes the normalised copy of a profile upload beside it and says where the
 * profile should point instead. This is what a profile save uses.
 *
 * Beside, not in place: once an upload's reservation starts finalizing, its
 * path is tombstoned and Storage refuses every write to it
 * (`guard_upload_storage_object_write`, pinned by
 * `profile-media-postgrest.test.ts`), so an in-place resize has not landed on
 * any upload since 2026-08-19. A fresh path under the owner's prefix is not
 * tombstoned. The service role writes it without a reservation, as it writes
 * generation previews and display renditions, and the account-deletion sweep
 * removes it with the rest of the prefix. The upload itself is never touched,
 * so every check the upload state machine makes against it still holds.
 *
 * Null when there is nothing to do (the image is already right, the path is
 * already a normalised copy, the URL is not a public profile URL) and when
 * anything fails, which is logged: the profile then keeps the upload it was
 * given, a correct if oversized image, and the save goes on.
 */
export async function deriveNormalizedProfileImage({
  adminSupabase,
  filePath,
  sourceUrl,
}: {
  adminSupabase: SupabaseClient;
  filePath: string;
  sourceUrl: string;
}): Promise<{ filePath: string; url: string } | null> {
  const role = getProfileImageRole(filePath);
  if (!role || isNormalizedProfileImagePath(filePath)) return null;
  // Refused before spending a download: a copy no URL can name is no use.
  if (!buildProfileImagePublicUrl(sourceUrl, filePath)) return null;

  try {
    const storage = adminSupabase.storage.from(PROFILE_IMAGE_BUCKET);
    const download = await storage.download(filePath);
    if (download.error || !download.data) {
      throw download.error ?? new Error(`Profile image ${filePath} could not be read.`);
    }

    const normalized = await encodeNormalizedProfileImage(
      Buffer.from(await download.data.arrayBuffer()),
      role,
    );
    if (!normalized) return null;

    const normalizedPath = buildNormalizedProfileImagePath(filePath, getMediaContentHash(normalized));
    const url = buildProfileImagePublicUrl(sourceUrl, normalizedPath);
    if (!url) return null;

    const upload = await storage.upload(normalizedPath, toStorageUploadBody(normalized, 'image/webp'), {
      contentType: 'image/webp',
      // The name is the content's hash, so a second write is the same bytes.
      upsert: true,
      cacheControl: '3600',
    });
    if (upload.error) throw upload.error;

    // A profile is never revisited once it points somewhere, so a copy that
    // landed damaged would stay broken; read it back before pointing at it.
    await assertStoredPreviewIsIntact({
      supabase: adminSupabase,
      location: { bucket: PROFILE_IMAGE_BUCKET, filePath: normalizedPath },
      expected: normalized,
    });
    return { filePath: normalizedPath, url };
  } catch (error) {
    logBackendWarning('failed_to_normalize_profile_image', { error, filePath });
    return null;
  }
}

/**
 * Resizes a stored profile image in place, for the backfill of images that
 * predate server-side normalisation; a profile save writes a copy instead
 * (`deriveNormalizedProfileImage`).
 *
 * In place, so no column has to be rewritten. That only works for an object
 * whose path was never tombstoned: Storage refuses the rewrite of any upload
 * finalized since 2026-08-19, so for those this is a logged no-op. A
 * normalised copy is never rewritten, because its name is its content's hash.
 *
 * Returns whether it rewrote the object. A failure is reported as `false` and
 * logged, never thrown.
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
  if (!role || isNormalizedProfileImagePath(filePath)) return false;

  try {
    const storage = adminSupabase.storage.from(bucket);
    const download = await storage.download(filePath);
    if (download.error || !download.data) return false;

    const normalized = await encodeNormalizedProfileImage(
      Buffer.from(await download.data.arrayBuffer()),
      role,
    );
    if (!normalized) return false;

    const upload = await storage.upload(filePath, toStorageUploadBody(normalized, 'image/webp'), {
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
