import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import type { ShowcaseFeedItem } from '@/lib/showcase';
import { getShowcaseFeedItemsByPostIds } from '@/lib/showcase-feed';

/**
 * A post's remixes, the list its remix count opens (owner, 2026-11-05). Only
 * remixes posted where anyone may see them: public, visible and not archived,
 * through the post each one credits (posts.remix_parent_post_id,
 * 20261105150143). The count also holds remixes never posted, so the list can
 * be shorter than it. Each remix is drawn as every public read draws a post
 * (`getShowcaseFeedItemsByPostIds`), which leaves out anyone the viewer is
 * blocked with, either way, and covers NSFW posts.
 */

export const POST_REMIXES_PAGE_SIZE = 24;
export const POST_REMIXES_MAX_PAGE_SIZE = 48;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PostRemixesPageInfo = {
  hasMore: boolean;
  nextOffset: number | null;
  limit: number;
  offset: number;
};

export type PostRemixesResult =
  | { ok: true; body: { success: true; items: ShowcaseFeedItem[]; pageInfo: PostRemixesPageInfo } }
  | { ok: false; status: 404 | 500; body: { error: string } };

export type PostRemixesDependencies = {
  isUserRelationshipBlocked: typeof isUserRelationshipBlocked;
  getShowcaseFeedItemsByPostIds: typeof getShowcaseFeedItemsByPostIds;
};

const NOT_FOUND = { ok: false, status: 404, body: { error: 'Post not found.' } } as const;
const FAILED = { ok: false, status: 500, body: { error: 'Failed to load remixes.' } } as const;

export function normalizePostRemixesLimit(value: string | null | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return POST_REMIXES_PAGE_SIZE;
  return Math.min(Math.trunc(parsed), POST_REMIXES_MAX_PAGE_SIZE);
}

export function normalizePostRemixesOffset(value: string | null | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

export async function listPostRemixes({
  adminSupabase,
  postId,
  viewerUserId,
  countryCode,
  limit,
  offset,
  dependencies,
}: {
  adminSupabase: SupabaseClient;
  postId: string;
  viewerUserId: string | null;
  countryCode: string | null;
  limit: number;
  offset: number;
  dependencies?: Partial<PostRemixesDependencies>;
}): Promise<PostRemixesResult> {
  const resolved: PostRemixesDependencies = {
    isUserRelationshipBlocked: dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
    getShowcaseFeedItemsByPostIds: dependencies?.getShowcaseFeedItemsByPostIds ?? getShowcaseFeedItemsByPostIds,
  };
  const id = postId.trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) return NOT_FOUND;

  // The post whose remixes these are: one its link opens, as the read by id
  // answers it, and never across a block.
  const { data: post, error: postError } = await adminSupabase
    .from('posts')
    .select('id, user_id')
    .eq('id', id)
    .in('visibility', ['public', 'unlisted'])
    .eq('review_status', 'visible')
    .is('archived_at', null)
    .maybeSingle();
  if (postError) {
    logBackendError('failed_to_load_remixed_post', { error: postError });
    return FAILED;
  }
  if (!post) return NOT_FOUND;

  const creatorId = (post as { user_id: string | null }).user_id;
  if (viewerUserId && creatorId && creatorId !== viewerUserId) {
    try {
      if (await resolved.isUserRelationshipBlocked({
        adminSupabase,
        firstUserId: viewerUserId,
        secondUserId: creatorId,
      })) {
        return NOT_FOUND;
      }
    } catch (error) {
      // A block is a safety boundary: an answer that could not be had shows nothing.
      logBackendError('failed_to_check_remixed_post_block', { error });
      return FAILED;
    }
  }

  // Newest first; one more than a page says whether another follows.
  const { data: rows, error: rowsError } = await adminSupabase
    .from('posts')
    .select('id')
    .eq('remix_parent_post_id', id)
    .eq('visibility', 'public')
    .eq('review_status', 'visible')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit);
  if (rowsError) {
    logBackendError('failed_to_list_post_remixes', { error: rowsError });
    return FAILED;
  }

  const remixIds = ((rows ?? []) as Array<{ id: string }>).map((row) => row.id);
  const hasMore = remixIds.length > limit;
  const items = await resolved.getShowcaseFeedItemsByPostIds({
    postIds: remixIds.slice(0, limit),
    viewerUserId,
    countryCode,
  });

  return {
    ok: true,
    body: {
      success: true,
      items,
      pageInfo: { hasMore, nextOffset: hasMore ? offset + limit : null, limit, offset },
    },
  };
}
