import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import type { PostResourceBundleResources } from '@/lib/post-resource-bundles';
import type { ShowcaseMediaItem } from '@/lib/showcase';

type PurchasedProofMediaRow = {
  purchase_id: string;
  source_media_id: string | null;
  media_key: string;
  storage_path: string | null;
  external_url: string | null;
  preview_storage_path: string | null;
  rendition_storage_path: string | null;
  preview_thumbhash: string | null;
  media_kind: 'image' | 'video';
  content_type: string | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | string | null;
  sort_order: number;
};

function buildScopedMediaPlaceholders(resources: PostResourceBundleResources): ShowcaseMediaItem[] {
  const mediaKeys: string[] = [];
  const seen = new Set<string>();
  const appendScope = (scope: { kind: 'all' } | { kind: 'media'; mediaKeys: string[] } | null | undefined) => {
    if (scope?.kind !== 'media') return;
    for (const mediaKey of scope.mediaKeys) {
      const normalized = mediaKey.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      mediaKeys.push(normalized);
    }
  };

  for (const section of [...(resources.sections ?? [])].sort((left, right) => left.sortOrder - right.sortOrder)) {
    appendScope(section.scope);
  }
  for (const item of [...(resources.items ?? [])].sort((left, right) => left.sortOrder - right.sortOrder)) {
    appendScope(item.scope);
  }

  return mediaKeys.map((mediaKey, sortOrder) => ({
    id: `retained-scope:${mediaKey}`,
    mediaKey,
    url: '',
    previewUrl: null,
    previewThumbhash: null,
    mediaKind: 'image',
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder,
  }));
}

export async function loadPurchasedProofMedia({
  adminSupabase,
  purchaseId,
  resources,
  includeStoredUrls,
}: {
  adminSupabase: SupabaseClient;
  purchaseId: string;
  resources: PostResourceBundleResources;
  includeStoredUrls: boolean;
}): Promise<ShowcaseMediaItem[]> {
  const { data, error } = await adminSupabase
    .from('post_resource_purchase_media')
    .select('purchase_id, source_media_id, media_key, storage_path, external_url, preview_storage_path, rendition_storage_path, preview_thumbhash, media_kind, content_type, original_name, width, height, duration_seconds, sort_order')
    .eq('purchase_id', purchaseId)
    .order('sort_order', { ascending: true });

  if (error) {
    // A rolling deployment or an older detached purchase still gets numbered
    // selectors reconstructed from its immutable resource scopes.
    logBackendError('purchased_proof_media_load_failed', { error });
    return buildScopedMediaPlaceholders(resources);
  }

  const rows = (data ?? []) as PurchasedProofMediaRow[];
  if (rows.length === 0) return buildScopedMediaPlaceholders(resources);

  const publicUrl = (storagePath: string | null) => storagePath && includeStoredUrls
    ? adminSupabase.storage.from('showcase_media').getPublicUrl(storagePath).data.publicUrl
    : null;

  return rows.map((row) => {
    const storedUrl = publicUrl(row.storage_path);
    const url = row.external_url?.trim() || storedUrl || '';
    const previewUrl = publicUrl(row.preview_storage_path)
      ?? (row.media_kind === 'image' ? url || null : null);
    const renditionUrl = publicUrl(row.rendition_storage_path);
    const duration = row.duration_seconds == null ? null : Number(row.duration_seconds);

    return {
      id: row.source_media_id ?? `${row.purchase_id}:${row.media_key}`,
      mediaKey: row.media_key,
      url,
      renditionUrl,
      previewUrl,
      previewThumbhash: row.preview_thumbhash,
      mediaKind: row.media_kind,
      contentType: row.content_type,
      originalName: row.original_name,
      width: row.width,
      height: row.height,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      sortOrder: row.sort_order,
    };
  });
}

/**
 * Removes paths pinned by a buyer's immutable proof-media snapshot from a
 * normal edit cleanup. Any lookup failure is fail-closed: leaking an obsolete
 * object temporarily is safer than breaking a paid revision permanently.
 * Account deletion uses a separate cleanup path and intentionally bypasses
 * this guard.
 */
export async function excludePurchasedProofMediaPaths(
  adminSupabase: SupabaseClient,
  candidatePaths: string[],
  options: { bundleId?: string | null } = {},
): Promise<string[]> {
  const uniquePaths = [...new Set(candidatePaths.filter(Boolean))];
  if (uniquePaths.length === 0) return [];

  const columns = ['storage_path', 'preview_storage_path', 'rendition_storage_path'] as const;
  const results = await Promise.all([
    ...columns.map((column) => (
      adminSupabase
        .from('post_resource_purchase_media')
        .select('storage_path, preview_storage_path, rendition_storage_path, sort_order')
        .in(column, uniquePaths)
        .order('sort_order', { ascending: true })
    )),
    ...(options.bundleId ? [
      adminSupabase
        .from('post_resource_bundle_orders')
        .select('quoted_media, created_at')
        .eq('bundle_id', options.bundleId)
        // A provider order can be marked paid between the purchase-media
        // lookup and this query. Keep both states protected; the paid row's
        // purchase snapshot is also checked above, while this closes the
        // narrow statement-snapshot gap during settlement.
        .in('status', ['created', 'paid'])
        .not('quoted_media', 'is', null)
        .order('created_at', { ascending: true }),
    ] : []),
  ]);

  if (results.some((result) => result.error)) {
    logBackendError('purchased_proof_media_cleanup_guard_failed', {
      error: results.find((result) => result.error)?.error,
    });
    return [];
  }

  const protectedPaths = new Set<string>();
  for (const result of results) {
    for (const row of (result.data ?? []) as Array<{
      storage_path?: string | null;
      preview_storage_path?: string | null;
      rendition_storage_path?: string | null;
    }>) {
      if (row.storage_path) protectedPaths.add(row.storage_path);
      if (row.preview_storage_path) protectedPaths.add(row.preview_storage_path);
      if (row.rendition_storage_path) protectedPaths.add(row.rendition_storage_path);
    }
  }

  if (options.bundleId) {
    const pendingOrderResult = results[columns.length] as {
      data?: Array<{ quoted_media?: unknown }> | null;
      error?: unknown;
    };
    for (const row of pendingOrderResult.data ?? []) {
      if (!Array.isArray(row.quoted_media)) continue;
      for (const media of row.quoted_media) {
        if (!media || typeof media !== 'object') continue;
        for (const key of ['storage_path', 'preview_storage_path', 'rendition_storage_path']) {
          const path = (media as Record<string, unknown>)[key];
          if (typeof path === 'string' && uniquePaths.includes(path)) {
            protectedPaths.add(path);
          }
        }
      }
    }
  }

  return uniquePaths.filter((path) => !protectedPaths.has(path));
}
