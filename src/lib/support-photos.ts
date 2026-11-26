import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from '@/lib/image-decoder';

import { logBackendWarning } from '@/lib/backend-logger';
import { getPreviewThumbhash } from '@/lib/media-preview-metadata';
import { getConfirmedRemovedPaths, markMediaUploadIntentsConsumed } from '@/lib/media-upload-intents';
import { getStorageLocation } from '@/lib/storage-path';
import { toStorageUploadBody } from '@/lib/storage-upload-body';
import {
  abortUploadByteConsumption,
  completeUploadByteConsumption,
  type UploadConsumptionClaim,
} from '@/lib/upload-byte-admission';
import { finalizeUploadForConsumption } from '@/lib/upload-finalization';

import {
  SUPPORT_PHOTO_MAX_BYTES,
  isSupportPhotoType,
  type SupportPhoto,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

/**
 * Photos in help & support conversations (owner, 2026-11-22: "Yes, build
 * photos"). The account stages its photo in `uploads` like any upload; the send
 * claims it (`claimStagedSupportPhoto`), the console's photo arrives with its
 * send instead. Either way the server re-encodes the picture
 * (`encodeSupportPhoto`): upright, as WebP, at up to 2560 px for the
 * full-screen view and 720 px for the thread, with nothing of the original
 * file's metadata, such as a phone photo's location. Both copies go to the
 * private support_attachments bucket under the account's own folder
 * (`storeSupportPhoto`), so the account's deletion takes them; clients only
 * get signed links (`signSupportPhotoLinks`).
 */

export const SUPPORT_ATTACHMENTS_BUCKET = 'support_attachments';
const STAGING_BUCKET = 'uploads';

/** How long a photo's signed links last. Clients keep the first ones until they are close to it. */
export const SUPPORT_PHOTO_LINK_SECONDS = 3 * 60 * 60;

const FULL_MAX_SIDE = 2560;
const PREVIEW_MAX_SIDE = 720;
/** A 48-megapixel phone photo fits; a decompression bomb does not. */
const MAX_INPUT_PIXELS = 60_000_000;
const READABLE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);
/** The copies never change once written (each has a path of its own). */
const PHOTO_CACHE_CONTROL = '604800';

export type SupportPhotoRefusalCode = 'PHOTO_NOT_FOUND' | 'PHOTO_UNREADABLE' | 'PHOTO_TOO_LARGE';

/** A photo the server has stored: what `send_support_message` keeps (`p_attachment`). */
export type StoredSupportPhoto = {
  kind: 'image';
  path: string;
  previewPath: string;
  width: number;
  height: number;
  bytes: number;
  thumbhash: string | null;
};

export type EncodedSupportPhoto = {
  full: Buffer;
  preview: Buffer;
  width: number;
  height: number;
  thumbhash: string | null;
};

/**
 * Re-encodes a picture for a conversation. Only what the server can read is
 * taken (JPEG, PNG, WebP, the first frame of a GIF); HEIC and anything else
 * is refused as unreadable. The size answered is the full copy's, upright.
 */
export async function encodeSupportPhoto(
  input: Uint8Array,
): Promise<{ ok: true; photo: EncodedSupportPhoto } | { ok: false; code: 'PHOTO_UNREADABLE' }> {
  try {
    const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    const metadata = await image.metadata();
    if (!metadata.format || !READABLE_FORMATS.has(metadata.format)) {
      return { ok: false, code: 'PHOTO_UNREADABLE' };
    }

    const full = await image
      .clone()
      .resize({ width: FULL_MAX_SIDE, height: FULL_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const preview = await image
      .clone()
      .resize({ width: PREVIEW_MAX_SIDE, height: PREVIEW_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();

    let thumbhash: string | null = null;
    try {
      thumbhash = await getPreviewThumbhash(preview);
    } catch {
      // The placeholder is a nicety: a photo without one still goes.
    }

    return {
      ok: true,
      photo: { full: full.data, preview, width: full.info.width, height: full.info.height, thumbhash },
    };
  } catch {
    return { ok: false, code: 'PHOTO_UNREADABLE' };
  }
}

/**
 * Writes a photo's two copies under the account's folder of
 * support_attachments. A copy that did not land takes the other with it, so a
 * failure leaves nothing behind for anyone to collect.
 */
export async function storeSupportPhoto(
  adminSupabase: SupabaseClient,
  {
    ownerUserId,
    photo,
    createId = randomUUID,
  }: { ownerUserId: string; photo: EncodedSupportPhoto; createId?: () => string },
): Promise<StoredSupportPhoto> {
  const id = createId();
  const path = `${ownerUserId}/${id}.webp`;
  const previewPath = `${ownerUserId}/${id}.preview.webp`;
  const bucket = adminSupabase.storage.from(SUPPORT_ATTACHMENTS_BUCKET);
  const options = { contentType: 'image/webp', cacheControl: PHOTO_CACHE_CONTROL, upsert: false };

  const fullUpload = await bucket.upload(path, toStorageUploadBody(photo.full, 'image/webp'), options);
  if (fullUpload.error) {
    await removeSupportPhotoCopies(adminSupabase, [path]);
    throw new Error(`Failed to store the support photo: ${fullUpload.error.message}`);
  }

  const previewUpload = await bucket.upload(previewPath, toStorageUploadBody(photo.preview, 'image/webp'), options);
  if (previewUpload.error) {
    await removeSupportPhotoCopies(adminSupabase, [path, previewPath]);
    throw new Error(`Failed to store the support photo preview: ${previewUpload.error.message}`);
  }

  return {
    kind: 'image',
    path,
    previewPath,
    width: photo.width,
    height: photo.height,
    bytes: photo.full.byteLength,
    thumbhash: photo.thumbhash,
  };
}

/** Removes a photo's copies; a failure is logged, and the orphan listing finds what stayed. */
export async function removeSupportPhotoCopies(adminSupabase: SupabaseClient, paths: readonly string[]): Promise<void> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return;
  try {
    const { error } = await adminSupabase.storage.from(SUPPORT_ATTACHMENTS_BUCKET).remove(unique);
    if (error) logBackendWarning('support_photo_remove_failed', { error: error.message, count: unique.length });
  } catch (error) {
    logBackendWarning('support_photo_remove_failed', {
      error: error instanceof Error ? error.message : String(error),
      count: unique.length,
    });
  }
}

export type StagedSupportPhotoClaim = {
  bytes: Uint8Array;
  claim: UploadConsumptionClaim;
  /** The staged object, inside `uploads`. */
  stagedPath: string;
};

/**
 * Claims the photo the account staged in `uploads` (`uploads/<account>/…`) and
 * reads it. The claim is the upload pipeline's lease: the reclaim sweep leaves
 * the object alone until `settleStagedSupportPhoto` completes it or
 * `releaseStagedSupportPhoto` gives it back. Only the account's own, finished
 * upload of a readable type within the cap is taken.
 */
export async function claimStagedSupportPhoto(
  adminSupabase: SupabaseClient,
  { userId, storagePath }: { userId: string; storagePath: string },
): Promise<{ ok: true; staged: StagedSupportPhotoClaim } | { ok: false; code: SupportPhotoRefusalCode }> {
  const location = getStorageLocation(storagePath);
  if (!location || location.bucket !== STAGING_BUCKET) return { ok: false, code: 'PHOTO_NOT_FOUND' };

  const finalization = await finalizeUploadForConsumption(adminSupabase, {
    bucket: STAGING_BUCKET,
    storagePath: location.filePath,
    userId,
    disposition: 'delete',
  });
  if (!finalization.ok) {
    if (finalization.status === 500) throw new Error(finalization.error);
    return { ok: false, code: 'PHOTO_NOT_FOUND' };
  }
  // An upload from before reservations has no lease to take: none of the
  // clients that can send a photo stages one that way.
  if (!finalization.consumptionClaim || !finalization.descriptor) return { ok: false, code: 'PHOTO_NOT_FOUND' };

  const claim = finalization.consumptionClaim;
  const refuse = async (code: SupportPhotoRefusalCode) => {
    await releaseStagedSupportPhoto(adminSupabase, claim);
    return { ok: false as const, code };
  };

  if (finalization.descriptor.sizeBytes > SUPPORT_PHOTO_MAX_BYTES) return refuse('PHOTO_TOO_LARGE');
  if (!isSupportPhotoType(finalization.descriptor.contentType)) return refuse('PHOTO_UNREADABLE');

  const download = await adminSupabase.storage.from(STAGING_BUCKET).download(finalization.canonicalPath);
  if (download.error || !download.data) {
    await releaseStagedSupportPhoto(adminSupabase, claim);
    throw new Error('Failed to read the staged support photo.');
  }

  return {
    ok: true,
    staged: {
      bytes: new Uint8Array(await download.data.arrayBuffer()),
      claim,
      stagedPath: finalization.canonicalPath,
    },
  };
}

/** Gives a claimed upload back untouched: the send did not keep it. */
export async function releaseStagedSupportPhoto(adminSupabase: SupabaseClient, claim: UploadConsumptionClaim) {
  const released = await abortUploadByteConsumption(adminSupabase, claim);
  if (!released.ok) logBackendWarning('support_photo_release_failed', { error: released.error });
}

/**
 * The send kept the photo: the lease is completed, the staged object removed
 * and its intent marked consumed by `support_message`. The message is already
 * sent, so a bookkeeping failure here is logged, never answered; the sweeps
 * collect what is left.
 */
export async function settleStagedSupportPhoto(
  adminSupabase: SupabaseClient,
  { staged, userId }: { staged: Pick<StagedSupportPhotoClaim, 'claim' | 'stagedPath'>; userId: string },
) {
  const completed = await completeUploadByteConsumption(adminSupabase, { claim: staged.claim, disposition: 'delete' });
  if (!completed.ok) {
    logBackendWarning('support_photo_lease_complete_failed', { error: completed.error });
    return;
  }

  const removal = await adminSupabase.storage.from(STAGING_BUCKET).remove([staged.stagedPath]);
  // Only what Storage confirmed gone is marked cleared: the rest stays for the
  // reclaim sweep, which a cleared mark would hide it from.
  const { confirmed, unconfirmed } = getConfirmedRemovedPaths([staged.stagedPath], removal);
  if (confirmed.length > 0) {
    await markMediaUploadIntentsConsumed(adminSupabase, {
      storagePaths: confirmed,
      userId,
      consumedBy: 'support_message',
      storageCleared: true,
    });
  }
  if (unconfirmed.length > 0) {
    await markMediaUploadIntentsConsumed(adminSupabase, {
      storagePaths: unconfirmed,
      userId,
      consumedBy: 'support_message',
      storageCleared: false,
    });
  }
}

/**
 * Signed links for photos' copies, in one Storage call. A copy Storage cannot
 * sign (it is gone) has none: its message is still answered, with the photo
 * saying it could not be loaded.
 */
export async function signSupportPhotoLinks(
  adminSupabase: SupabaseClient,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const links = new Map<string, string>();
  if (unique.length === 0) return links;

  const { data, error } = await adminSupabase.storage
    .from(SUPPORT_ATTACHMENTS_BUCKET)
    .createSignedUrls(unique, SUPPORT_PHOTO_LINK_SECONDS);
  if (error) throw new Error(`Failed to sign support photo links: ${error.message}`);

  for (const item of data ?? []) {
    if (item.path && item.signedUrl && !item.error) links.set(item.path, item.signedUrl);
  }
  return links;
}

/** A stored photo as clients read it, with the links signed for it. */
export function toSupportPhoto(
  stored: Pick<StoredSupportPhoto, 'path' | 'previewPath' | 'width' | 'height' | 'thumbhash'>,
  links: ReadonlyMap<string, string>,
  now: number = Date.now(),
): SupportPhoto {
  return {
    kind: 'image',
    previewUrl: links.get(stored.previewPath) ?? null,
    url: links.get(stored.path) ?? null,
    width: stored.width,
    height: stored.height,
    thumbhash: stored.thumbhash,
    expiresAt: new Date(now + SUPPORT_PHOTO_LINK_SECONDS * 1000).toISOString(),
  };
}

/** The photo `send_support_message` keeps, as its `p_attachment`. */
export function supportPhotoAttachmentArgument(photo: StoredSupportPhoto) {
  return {
    kind: photo.kind,
    path: photo.path,
    preview_path: photo.previewPath,
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    thumbhash: photo.thumbhash,
  };
}
