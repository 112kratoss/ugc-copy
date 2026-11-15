import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { PRIVATE_POST_MEDIA_BUCKET, postMediaReadUrl, postMediaStorageBucket } from '@/lib/post-media-storage';

import type { SearchThumbnail } from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

export type { SearchThumbnail };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A search row's picture, from what the database answers for it
 * (`search_post_picture`, migration `20261115105944_search_content_suggestions.sql`):
 * the cover preview of a post that row opens for the viewer, by its stored
 * path. The database has already left out a labelled post, one that is not
 * public and visible, and both sides of a block with the viewer.
 *
 * The URL is the one a post result's cover carries as `previewUrl`, built by
 * the same function from the same column (`postMediaReadUrl` over
 * `post_media.preview_storage_path`), with no read of storage. A path in the
 * private bucket is where a labelled post's media lives: it is never turned
 * into an address here, whatever the database answered.
 *
 * A picture is an extra: a row the database answers none for, or one this
 * cannot read, is drawn without it.
 */
export function searchThumbnailFromRow(client: SupabaseClient, row: unknown): SearchThumbnail | null {
  if (!isRecord(row) || typeof row.post_id !== 'string' || !row.post_id) return null;
  if (typeof row.path !== 'string' || !row.path) return null;
  if (postMediaStorageBucket(row.path) === PRIVATE_POST_MEDIA_BUCKET) return null;
  const url = postMediaReadUrl(client, row.path);
  if (!url) return null;
  return {
    postId: row.post_id,
    url,
    thumbhash: typeof row.thumbhash === 'string' && row.thumbhash ? row.thumbhash : null,
    width: positiveSize(row.width),
    height: positiveSize(row.height),
    mediaKind: row.media_kind === 'video' ? 'video' : 'image',
  };
}
