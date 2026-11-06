import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadBlockedCreatorIds } from '@/lib/moderation-service';
import { SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS } from '@/lib/showcase';

/**
 * Explore's first page is built for everyone (`viewerUserId: null`) so that it
 * can be cached and painted without waiting for sign-in, and the viewer's own
 * feed is merged in under the rows already drawn. Nothing took out of those
 * rows what the viewer's own feed leaves out: a creator they blocked, or hid,
 * was back on screen after every reload.
 *
 * This answers, for the posts a page has drawn, which of them the viewer's
 * feed would not have carried. It reads only what it is asked about: no list
 * of whom the viewer blocked, or of who blocked them, leaves the server.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ShowcaseViewerExclusionItem = { postId: string; creatorId: string | null };

export type ShowcaseViewerExclusions = {
  /** Creators with a block between them and the viewer, either way: left out of every feed. */
  blockedCreatorIds: string[];
  /** The viewer's own feed preferences (Hide, Not interested): left out of For you. */
  hiddenCreatorIds: string[];
  hiddenPostIds: string[];
};

export type ShowcaseViewerExclusionsRouteResult =
  | { ok: true; body: ShowcaseViewerExclusions }
  | { ok: false; status: number; body: { error: string } };

function normalizeUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * The people a page's remix credits name (`ugc-mobile/lib/remix-credit`),
 * asked about beside the posts' creators: blocks only, since a credit is no
 * one's post to hide. Each once, ids that are ids, as many as a page of credits
 * names; anything else is left out.
 */
export function parseShowcaseViewerExclusionCreditCreatorIds(body: unknown): string[] {
  const rawIds = body && typeof body === 'object' ? (body as { creditCreatorIds?: unknown }).creditCreatorIds : null;
  if (!Array.isArray(rawIds)) return [];
  const ids = new Set<string>();
  for (const rawId of rawIds) {
    if (ids.size >= SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS * 2) break;
    const id = normalizeUuid(rawId);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** The posts asked about, each once, with ids that are ids. `null` when the body is not a list of them. */
export function parseShowcaseViewerExclusionItems(body: unknown): ShowcaseViewerExclusionItem[] | null {
  const rawItems = body && typeof body === 'object' ? (body as { items?: unknown }).items : null;
  if (!Array.isArray(rawItems)) return null;

  const itemsByPostId = new Map<string, ShowcaseViewerExclusionItem>();
  for (const rawItem of rawItems) {
    if (itemsByPostId.size >= SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS) break;
    const record = rawItem && typeof rawItem === 'object' ? rawItem as { postId?: unknown; creatorId?: unknown } : null;
    const postId = normalizeUuid(record?.postId);
    if (!postId || itemsByPostId.has(postId)) continue;
    itemsByPostId.set(postId, { postId, creatorId: normalizeUuid(record?.creatorId) });
  }
  return [...itemsByPostId.values()];
}

export async function getShowcaseViewerExclusionsForRoute({
  adminSupabase,
  items,
  creditCreatorIds = [],
  viewerUserId,
}: {
  adminSupabase: SupabaseClient;
  items: ShowcaseViewerExclusionItem[];
  /** People the page's remix credits name: asked about blocks only. */
  creditCreatorIds?: string[];
  viewerUserId: string;
}): Promise<ShowcaseViewerExclusionsRouteResult> {
  if (items.length === 0) {
    return { ok: true, body: { blockedCreatorIds: [], hiddenCreatorIds: [], hiddenPostIds: [] } };
  }

  const postIds = items.map((item) => item.postId);
  const creatorIds = [...new Set(
    items.map((item) => item.creatorId).filter((id): id is string => Boolean(id) && id !== viewerUserId),
  )];
  const blockCheckedIds = [...new Set([
    ...creatorIds,
    ...creditCreatorIds.filter((id) => id !== viewerUserId),
  ])];

  // The same three reads the feed itself makes for a viewer (`showcase-feed.ts`,
  // `showcase-feed-personalization.ts`), over the posts asked about.
  const [blockedCreatorIds, postFeedback, creatorFeedback] = await Promise.all([
    loadBlockedCreatorIds({ adminSupabase, creatorIds: blockCheckedIds, viewerUserId }),
    adminSupabase
      .from('feed_user_post_feedback')
      .select('post_id')
      .eq('user_id', viewerUserId)
      .eq('is_active', true)
      .in('post_id', postIds),
    creatorIds.length
      ? adminSupabase
        .from('feed_user_creator_feedback')
        .select('creator_user_id')
        .eq('user_id', viewerUserId)
        .eq('is_active', true)
        .in('creator_user_id', creatorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (postFeedback.error || creatorFeedback.error) {
    throw postFeedback.error ?? creatorFeedback.error;
  }

  // Only what was asked about goes back, whatever a query returns.
  const askedPostIds = new Set(postIds);
  const askedCreatorIds = new Set(creatorIds);
  const askedBlockIds = new Set(blockCheckedIds);
  return {
    ok: true,
    body: {
      blockedCreatorIds: [...blockedCreatorIds].filter((id) => askedBlockIds.has(id)).sort(),
      hiddenCreatorIds: [...new Set((creatorFeedback.data ?? []).map((row) => String(row.creator_user_id)))]
        .filter((id) => askedCreatorIds.has(id))
        .sort(),
      hiddenPostIds: [...new Set((postFeedback.data ?? []).map((row) => String(row.post_id)))]
        .filter((id) => askedPostIds.has(id))
        .sort(),
    },
  };
}
