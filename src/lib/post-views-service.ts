import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Post views reported by a client (POST /api/showcase/views): the post page,
 * a reel opened outside the feed, and every view of a web guest, whose feed
 * impressions are not counted (migration 20261123070740). The database makes
 * one mark per post, viewer and UTC day and holds a guest to 20 per network
 * per post per day; this module only reads the request and passes it on.
 */

/** Views in one request, as the database takes them. */
export const POST_VIEWS_MAX_BATCH = 25;

/**
 * Where a view was seen: a Home card (`feed`), the post page, or a reel.
 * Explore's grid is not a place a view is counted.
 */
export const POST_VIEW_SURFACES = ['feed', 'post-page', 'reel'] as const;

export type PostViewSurface = (typeof POST_VIEW_SURFACES)[number];

export type PostView = { postId: string; surface: PostViewSurface };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPostViewSurface(value: unknown): value is PostViewSurface {
  return typeof value === 'string' && (POST_VIEW_SURFACES as readonly string[]).includes(value);
}

/**
 * Reads `{ views: [{ postId, surface }] }`. A body that is not that shape, or
 * holds no view or more than 25, is refused; an entry that names no post id
 * or a surface this server does not know is dropped (a newer client's surface
 * costs that view, not the batch), and a post named twice is kept once.
 */
export function parsePostViewsPayload(
  value: unknown,
): { ok: true; views: PostView[] } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Invalid post views payload.' };
  }
  const views = (value as { views?: unknown }).views;
  if (!Array.isArray(views) || views.length === 0 || views.length > POST_VIEWS_MAX_BATCH) {
    return { ok: false, error: `Send between 1 and ${POST_VIEWS_MAX_BATCH} views.` };
  }

  const seen = new Set<string>();
  const kept: PostView[] = [];
  for (const entry of views) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { postId, surface } = entry as { postId?: unknown; surface?: unknown };
    if (typeof postId !== 'string' || !UUID_PATTERN.test(postId) || !isPostViewSurface(surface)) continue;
    const id = postId.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push({ postId: id, surface });
  }
  return { ok: true, views: kept };
}

/**
 * Records the views for one viewer: an account by its id, or a guest by its
 * hashed key and the hashed network it came from. Returns how many were new
 * marks; the route answers the same whatever it is.
 */
export async function recordPostViews(
  serviceClient: SupabaseClient,
  input: {
    viewerUserId: string | null;
    anonymousKeyHash: string | null;
    networkKeyHash: string;
    views: PostView[];
  },
): Promise<number> {
  if (input.views.length === 0) return 0;
  const isGuest = !input.viewerUserId;
  if (isGuest && !input.anonymousKeyHash) {
    throw new Error('A guest post view needs its key');
  }
  const { data, error } = await serviceClient.rpc('record_post_views', {
    p_viewer_user_id: input.viewerUserId,
    p_anonymous_key_hash: isGuest ? input.anonymousKeyHash : null,
    p_network_key_hash: isGuest ? input.networkKeyHash : null,
    p_views: input.views,
  });
  if (error) {
    throw new Error(`record_post_views failed: ${error.message}`);
  }
  return typeof data === 'number' ? data : 0;
}
