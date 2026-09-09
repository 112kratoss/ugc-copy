import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildPostMediaTeaserPath } from '@/lib/post-media-rendition';
import { getMediaContentHash } from '@/lib/media-preview-metadata';
import { summarizeMediaToolError } from '@/lib/media-tool-error';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';
import { toStorageUploadBody } from '@/lib/storage-upload-body';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL } from '@/lib/showcase-media-cache';
import { createVideoTeaserFromFile, withVideoInputFile, TEASER_SECONDS } from '@/lib/video-rendition';

const MAX_ATTEMPTS = 3;
// A standalone repair uses an existing lean rendition, never the original.
export const TEASER_REPAIR_MAX_BYTES = 32 * 1024 * 1024;

type TeaserClaim = {
  id: string;
  post_id: string;
  /** The generation a creation-published post links; its showcase prefix may hold the rendition. */
  generation_id?: string | null;
  rendition_storage_path: string;
  source_bytes: number;
};

function missingTeaserRepairSchema(error: { code?: string; message?: string } | null) {
  return Boolean(error && (
    error.code === 'PGRST202' || error.code === '42703' || error.code === 'PGRST204'
  ) && /teaser_|claim_post_media_teaser_repair/.test(error.message ?? ''));
}

export async function hasRepairablePostMediaTeasers(supabase: SupabaseClient) {
  const result = await supabase.from('post_media').select('id')
    .eq('media_kind', 'video').eq('rendition_status', 'ready')
    .gt('duration_seconds', 30).is('teaser_storage_path', null)
    .lt('teaser_attempt_count', MAX_ATTEMPTS)
    .or(`teaser_locked_at.is.null,teaser_locked_at.lt.${new Date(Date.now() - 300_000).toISOString()}`)
    .not('rendition_storage_path', 'is', null).limit(1);
  if (missingTeaserRepairSchema(result.error)) return false;
  if (result.error) throw result.error;
  return Boolean(result.data?.length);
}

/** One bounded encode, with its own lease and attempt budget. Full renditions stay ready. */
export async function repairPostMediaTeasers(supabase: SupabaseClient) {
  const empty = { attempted: 0, completed: 0, failed: 0 };
  const lockedBy = `media-teaser:${randomUUID()}`;
  const claim = await supabase.rpc('claim_post_media_teaser_repair', {
    p_locked_by: lockedBy, p_max_bytes: TEASER_REPAIR_MAX_BYTES,
  });
  if (missingTeaserRepairSchema(claim.error)) return empty;
  if (claim.error) throw claim.error;
  const row = (claim.data as TeaserClaim[] | null)?.[0];
  if (!row) return empty;
  try {
    const path = parseCanonicalStorageObjectPath(row.rendition_storage_path, { minimumSegments: 3 });
    // Upload-published posts file media under their own id; creation-published
    // ones keep it under the linked generation's showcase prefix. The claim
    // already applied this rule; repeating it here keeps a wrong row harmless.
    const ownedByPost = Boolean(path?.startsWith(`posts/${row.post_id}/`));
    const ownedByGeneration = Boolean(row.generation_id && path?.startsWith(`showcase/${row.generation_id}/`));
    if (!path || !(ownedByPost || ownedByGeneration)) throw new Error('Teaser source is outside the owning post.');
    if (!(row.source_bytes > 0 && row.source_bytes <= TEASER_REPAIR_MAX_BYTES)) throw new Error('Teaser source exceeds the byte budget.');
    const storage = supabase.storage.from('showcase_media');
    const download = await storage.download(path, {}, { signal: AbortSignal.timeout(30_000) });
    if (download.error || !download.data) throw download.error ?? new Error('Teaser source could not be read.');
    if (!download.data.size || download.data.size > TEASER_REPAIR_MAX_BYTES) throw new Error('Teaser source exceeds the byte budget.');
    const teaser = await withVideoInputFile(download.data, input => createVideoTeaserFromFile(input));
    if (!teaser.durationSeconds || teaser.durationSeconds > TEASER_SECONDS + 0.1 || !teaser.width || !teaser.height) {
      throw new Error('Encoded teaser has invalid duration or dimensions.');
    }
    const teaserPath = buildPostMediaTeaserPath(path, getMediaContentHash(teaser.buffer));
    const upload = await storage.upload(teaserPath, toStorageUploadBody(teaser.buffer, 'video/mp4'), {
      contentType: 'video/mp4', cacheControl: SHOWCASE_PUBLIC_MEDIA_CACHE_CONTROL, upsert: true,
    });
    if (upload.error) throw upload.error;
    const readback = await storage.download(teaserPath, {}, { signal: AbortSignal.timeout(15_000) });
    if (readback.error || !readback.data || !Buffer.from(await readback.data.arrayBuffer()).equals(teaser.buffer)) {
      throw new Error('Stored teaser differs from the encoded bytes.');
    }
    const updated = await supabase.from('post_media').update({
      teaser_storage_path: teaserPath, teaser_bytes: teaser.bytes,
      teaser_generated_at: new Date().toISOString(), teaser_error: null,
      teaser_locked_at: null, teaser_locked_by: null,
    }).eq('id', row.id).eq('teaser_locked_by', lockedBy)
      .eq('rendition_storage_path', path).is('teaser_storage_path', null).select('id');
    if (updated.error) throw updated.error;
    if (!updated.data?.length) throw new Error('Teaser source or lease changed before publication.');
    return { attempted: 1, completed: 1, failed: 0 };
  } catch (error) {
    const result = await supabase.from('post_media').update({
      teaser_error: summarizeMediaToolError(error, 'Teaser repair failed.'),
      teaser_locked_at: null, teaser_locked_by: null,
    }).eq('id', row.id).eq('teaser_locked_by', lockedBy);
    if (result.error) throw result.error;
    return { attempted: 1, completed: 0, failed: 1 };
  }
}
