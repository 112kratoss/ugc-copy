import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';
import { getMediaContentHash } from '@/lib/media-preview-metadata';
import { summarizeMediaToolError } from '@/lib/media-tool-error';
import { logBackendError } from '@/lib/backend-logger';
import { toStorageUploadBody } from '@/lib/storage-upload-body';
import {
  createVideoRenditionFromFile,
  VideoRenditionSkipped,
  withVideoInputFile,
} from '@/lib/video-rendition';

export const GENERATION_PLAYBACK_MAX_BYTES = 64 * 1024 * 1024;
const EMPTY = { attempted: 0, completed: 0, failed: 0 };
type Claim = { id: string; user_id: string; output_url: string; source_bytes: number };

function missingSchema(error: { code?: string; message?: string } | null) {
  return Boolean(
    error &&
      ['PGRST202', 'PGRST204', '42703'].includes(error.code ?? '') &&
      /playback_rendition/.test(error.message ?? ''),
  );
}
export async function hasPendingGenerationPlaybackRendition(supabase: SupabaseClient) {
  const result = await supabase.rpc('has_pending_generation_playback_rendition');
  if (missingSchema(result.error)) return false;
  if (result.error) throw result.error;
  return result.data === true;
}

/** One owned source per idle sweep; claim consumes the attempt before any I/O. */
export async function repairGenerationPlaybackRendition(supabase: SupabaseClient) {
  const lockedBy = `generation-playback:${randomUUID()}`;
  const claimed = await supabase.rpc('claim_generation_playback_rendition', {
    p_locked_by: lockedBy,
    p_max_bytes: GENERATION_PLAYBACK_MAX_BYTES,
  });
  if (missingSchema(claimed.error)) return EMPTY;
  if (claimed.error) throw claimed.error;
  const row = (claimed.data as Claim[] | null)?.[0];
  if (!row) return EMPTY;
  const signal = AbortSignal.timeout(150_000);
  let uploadedPath: string | null = null;
  const update = (values: Record<string, unknown>) =>
    supabase
      .from('generations')
      .update(values)
      .eq('id', row.id)
      .eq('user_id', row.user_id)
      .eq('output_url', row.output_url)
      .eq('playback_rendition_locked_by', lockedBy)
      .eq('playback_rendition_status', 'processing');
  try {
    const source = getUserOwnedStoredMediaLocation(row.output_url, row.user_id, {
      allowedBuckets: ['generated_videos'],
    });
    if (!source) throw new Error('Playback source is outside the owning generation.');
    if (
      !Number.isSafeInteger(row.source_bytes) ||
      row.source_bytes <= 0 ||
      row.source_bytes > GENERATION_PLAYBACK_MAX_BYTES
    ) {
      throw new Error('Playback source exceeds the byte budget.');
    }
    const storage = supabase.storage.from(source.bucket);
    const download = await storage.download(
      source.filePath,
      {},
      { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
    );
    if (download.error || !download.data) throw new Error('Playback source could not be read.');
    if (download.data.size !== row.source_bytes)
      throw new Error('Playback source changed after byte admission.');
    const rendition = await withVideoInputFile(download.data, (input, sourceBytes) =>
      createVideoRenditionFromFile(input, sourceBytes, { signal }),
    );
    if (
      !rendition.width ||
      !rendition.height ||
      !rendition.durationSeconds ||
      rendition.durationSeconds <= 0 ||
      rendition.bytes !== rendition.buffer.length ||
      rendition.bytes >= download.data.size
    ) {
      throw new Error('Playback rendition has invalid size or dimensions.');
    }
    const path = `${row.user_id}/playback/${row.id}/${getMediaContentHash(rendition.buffer)}.mp4`;
    uploadedPath = path;
    signal.throwIfAborted();
    const uploaded = await storage.upload(
      path,
      toStorageUploadBody(rendition.buffer, 'video/mp4'),
      {
        contentType: 'video/mp4',
        cacheControl: '31536000',
        upsert: true,
      },
    );
    if (uploaded.error) throw uploaded.error;
    const readback = await storage.download(
      path,
      {},
      { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
    );
    if (
      readback.error ||
      !readback.data ||
      !Buffer.from(await readback.data.arrayBuffer()).equals(rendition.buffer)
    ) {
      throw new Error('Stored playback rendition differs from encoded bytes.');
    }
    const result = await update({
      playback_rendition_path: `generated_videos/${path}`,
      playback_rendition_source: row.output_url,
      playback_rendition_status: 'ready',
      playback_rendition_bytes: rendition.bytes,
      playback_rendition_generated_at: new Date().toISOString(),
      playback_rendition_error: null,
      playback_rendition_locked_at: null,
      playback_rendition_locked_by: null,
    }).select('id');
    if (result.error) throw result.error;
    if (!result.data?.length)
      throw new Error('Playback source or lease changed before publication.');
    return { attempted: 1, completed: 1, failed: 0 };
  } catch (error) {
    if (uploadedPath) {
      // A different lease may be publishing the same content hash, so retain
      // it while the generation exists. A deleted generation cannot publish.
      try {
        const current = await supabase
          .from('generations')
          .select('id')
          .eq('id', row.id)
          .maybeSingle();
        if (!current.error && !current.data) {
          const removed = await supabase.storage.from('generated_videos').remove([uploadedPath]);
          if (removed.error) throw removed.error;
        }
      } catch (cleanupError) {
        logBackendError('private_playback_cleanup_failed', {
          generationId: row.id,
          error: cleanupError,
        });
      }
    }
    const skipped = error instanceof VideoRenditionSkipped;
    const result = await update({
      playback_rendition_status: skipped ? 'skipped' : 'failed',
      playback_rendition_error: summarizeMediaToolError(
        error,
        'Private playback rendition failed.',
      ),
      playback_rendition_locked_at: null,
      playback_rendition_locked_by: null,
    }).select('id');
    if (result.error) throw result.error;
    const completed = skipped && Boolean(result.data?.length);
    return { attempted: 1, completed: completed ? 1 : 0, failed: completed ? 0 : 1 };
  }
}
