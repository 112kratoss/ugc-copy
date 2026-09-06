import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveOwnedStoredMediaUrlMap } from '@/lib/owned-media-url-batch';
import { resolveOwnedStoredMediaUrl } from '@/lib/server-helpers';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

export type TemplateMediaGeneration = {
  id: string;
  user_id?: string;
  template_run_id: string | null;
  output_url: string | null;
  playback_rendition_path?: string | null;
  playback_rendition_source?: string | null;
  playback_rendition_status?: string | null;
  preview_url?: string | null;
  preview_status?: string | null;
};

export type TemplateMediaOutput = { url: string | null; generationId: string | null; kind: 'image' | 'video' };

/** Only media already admitted by the owned run may enter this projection. */
export async function resolveTemplateRunMedia({ client, ownerId, runId, generations, outputs }: {
  client: SupabaseClient;
  ownerId: string;
  runId: string;
  generations: Iterable<TemplateMediaGeneration>;
  outputs: TemplateMediaOutput[];
}) {
  const owned = [...generations].filter((generation) => generation.user_id === ownerId && generation.template_run_id === runId);
  const paths = outputs.map((output) => {
    const generation = owned.find((row) => row.output_url === output.url
      && (!output.generationId || row.id === output.generationId));
    let rendition: string | null = null;
    let preview: string | null = null;
    if (output.url && generation) {
      const location = generation.playback_rendition_path
        ? getUserOwnedStoredMediaLocation(generation.playback_rendition_path, ownerId, { allowedBuckets: ['generated_videos'] })
        : null;
      if (output.kind === 'video' && generation.playback_rendition_status === 'ready'
        && generation.playback_rendition_source === output.url
        && location?.filePath.startsWith(`${ownerId}/playback/${generation.id}/`)) {
        rendition = generation.playback_rendition_path!;
      }
      if (generation.preview_status === 'ready' && generation.preview_url
        && getUserOwnedStoredMediaLocation(generation.preview_url, ownerId, { allowedBuckets: ['generated_images', 'generated_videos'] })) {
        preview = generation.preview_url;
      }
    }
    return { original: output.url, rendition, preview };
  });
  const candidates = new Set(paths.flatMap((item) => [item.original, item.rendition, item.preview]).filter((value): value is string => Boolean(value)));
  const batchBuckets = new Set(['generated_images', 'generated_videos', 'generated_audio', 'generation_inputs']);
  const single: string[] = [];
  const batch: string[] = [];
  for (const value of candidates) {
    const location = getUserOwnedStoredMediaLocation(value, ownerId);
    // Fixed inputs can live in template_inputs; preserve their existing owned
    // resolver, while the much more common generated outputs share a batch.
    if (location && !batchBuckets.has(location.bucket)) single.push(value);
    else batch.push(value);
  }
  const urls = await resolveOwnedStoredMediaUrlMap({ supabase: client, outputUrls: batch, ownerUserIds: [ownerId] });
  await Promise.all(single.map(async (value) => urls.set(value, await resolveOwnedStoredMediaUrl(client, value, ownerId))));
  return paths.map((item) => {
    const url = item.original ? urls.get(item.original) ?? null : null;
    return {
      url,
      ...(url && item.rendition ? { renditionUrl: urls.get(item.rendition) ?? null } : {}),
      ...(url && item.preview ? { previewUrl: urls.get(item.preview) ?? null } : {}),
    };
  });
}
