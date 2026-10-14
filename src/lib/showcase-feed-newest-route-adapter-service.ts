import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import {
  applyPrivateNoStoreApiResponseHeaders,
  createApiTraceHeaders,
  createPrivateNoStoreApiResponseHeaders,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_FEED_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient } from '@/lib/server-helpers';
import { normalizeShowcaseCategory } from '@/lib/showcase';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';

/** The lanes one query on `posts` can name, without hydrating a post's media. */
export type ShowcaseFeedNewestCategory = 'all' | 'media' | 'text';

export type ShowcaseFeedNewestResponse = {
  newestPostId: string | null;
  newestPublishedAt: string | null;
};

// A client asks on its return to the foreground, at most once per lane per
// five minutes; thirty seconds of cache spares the database the same answer
// many times over, and makes a new post at most that late to its pill.
export const SHOWCASE_FEED_NEWEST_CACHE_CONTROL = 'public, max-age=30';

type ShowcaseFeedNewestRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  getNewestShowcaseFeedPost?: typeof getNewestShowcaseFeedPost;
  logError?: typeof logBackendRouteError;
};

/**
 * `category` read as the feed reads its own, so a lane asks about itself.
 * The feed tells `image` from `video` only after hydrating each post's media;
 * for those lanes the answer is `media`'s, the smallest lane a query names
 * that holds them both.
 */
export function normalizeShowcaseFeedNewestCategory(value: string | null): ShowcaseFeedNewestCategory {
  const category = normalizeShowcaseCategory(value);
  return category === 'image' || category === 'video' ? 'media' : category;
}

/**
 * The newest post of a lane in the feed's unranked recent order, one row.
 *
 * The predicates are `fetchPostRows`' in showcase-feed.ts: public, not
 * archived, `visible`, newest first, with media's and text's own filters.
 * NSFW is left out of every lane, as Explore's media lane leaves it out: a
 * pill announces posts the reader can see. Nothing here reads a viewer, opens
 * a feed session or records a delivery: the probe mints nothing.
 */
export async function getNewestShowcaseFeedPost({
  category,
  serviceClient,
}: {
  category: ShowcaseFeedNewestCategory;
  serviceClient: Pick<SupabaseClient, 'from'>;
}): Promise<ShowcaseFeedNewestResponse> {
  let query = serviceClient
    .from('posts')
    .select('id, created_at')
    .eq('visibility', 'public')
    .is('archived_at', null)
    .eq('review_status', 'visible')
    .eq('is_nsfw', false);
  if (category === 'media') {
    query = query.neq('post_format', 'text');
  } else if (category === 'text') {
    query = query.or('category.eq.text,post_format.eq.mixed');
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const row = data as { id: string; created_at: string } | null;
  return row
    ? { newestPostId: row.id, newestPublishedAt: new Date(row.created_at).toISOString() }
    : { newestPostId: null, newestPublishedAt: null };
}

function resolveDependencies(dependencies: ShowcaseFeedNewestRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    getNewestShowcaseFeedPost: dependencies?.getNewestShowcaseFeedPost ?? getNewestShowcaseFeedPost,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

async function handleShowcaseFeedNewestGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const category = normalizeShowcaseFeedNewestCategory(new URL(request.url).searchParams.get('category'));
    const serviceClient = dependencies.createServiceClient();

    // The general feed-read budget, keyed by network: this probe reads no
    // identity, and the For you budget pays for ranked sessions it never opens.
    try {
      await dependencies.enforceBackendRateLimit(serviceClient, {
        ...SHOWCASE_FEED_READ_RATE_LIMIT,
        key: dependencies.getFeedNetworkKeyHash(request),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return applyPrivateNoStoreApiResponseHeaders(createBackendRateLimitResponse(error), request);
      }
      dependencies.logError('Showcase feed newest rate limit failed:', error);
      return NextResponse.json(
        { error: 'Failed to check feed request limits.' },
        { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    const newest = await dependencies.getNewestShowcaseFeedPost({ category, serviceClient });
    // Every viewer gets the same answer, whatever token a client sends along.
    return NextResponse.json(newest, {
      headers: {
        'Cache-Control': SHOWCASE_FEED_NEWEST_CACHE_CONTROL,
        ...createApiTraceHeaders(request),
      },
    });
  } catch (error) {
    dependencies.logError('Showcase feed newest probe failed:', error);
    return NextResponse.json(
      { error: 'Failed to check for newer posts.' },
      { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
    );
  }
}

export async function getShowcaseFeedNewestRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseFeedNewestRouteDependencies;
  request: Request;
}) {
  return handleShowcaseFeedNewestGET(request, resolveDependencies(dependencies));
}
