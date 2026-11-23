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

/** A stored path this may turn into a public address: never one in the private bucket. */
function publicPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return postMediaStorageBucket(value) === PRIVATE_POST_MEDIA_BUCKET ? null : value;
}

/**
 * A search row's picture, from what the database answers for it
 * (`search_post_picture`, migrations `20261115105944_search_content_suggestions.sql`
 * and `20261123152813_post_media_search_thumbs.sql`): the cover of a post that
 * row opens for the viewer, by its stored paths. The database has already left
 * out a labelled post, one that is not public and visible, and both sides of a
 * block with the viewer.
 *
 * The URL is the cover's row thumb where it has one (`thumb_path`, a WebP 144 px
 * on its short side, about 5 KB: every client draws this picture in a frame of
 * 48 px or less), and otherwise its 720 px preview (`path`), the URL a post
 * result's cover carries as `previewUrl`. Either is built by `postMediaReadUrl`
 * with no read of storage. The choice is made here so an installed app, which
 * reads `url` alone, draws the small picture without an update. A path in the
 * private bucket is where a labelled post's media lives: it is never turned
 * into an address here, whatever the database answered.
 *
 * A picture is an extra: a row the database answers none for, or one this
 * cannot read, is drawn without it.
 */
export function searchThumbnailFromRow(client: SupabaseClient, row: unknown): SearchThumbnail | null {
  if (!isRecord(row) || typeof row.post_id !== 'string' || !row.post_id) return null;
  const previewPath = publicPath(row.path);
  if (!previewPath) return null;
  const url = postMediaReadUrl(client, publicPath(row.thumb_path) ?? previewPath);
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
