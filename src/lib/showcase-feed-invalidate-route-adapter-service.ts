import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendEvent } from '@/lib/backend-logger';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { PUBLIC_PAGE_CACHE_TAG } from '@/lib/public-page-cache';
import { invalidateShowcaseFeedCache, SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';

export const SHOWCASE_FEED_INVALIDATE_ROUTE = '/api/cron/showcase-feed-invalidate';

/**
 * Refreshes every page and read the feed's tag caches, on request: the same
 * `invalidateShowcaseFeedCache()` a publish, an edit or a take-down in the app
 * makes. For callers outside the app, where `next/cache` does not exist: the
 * moderation CLI calls it after a take-down or a dismissal
 * (`scripts/ops/moderation-ops.ts`), which otherwise left the post on the
 * signed-out home page until its window ran out.
 *
 * A manual trigger behind `CRON_SECRET` like the job routes beside it, but no
 * job: nothing schedules it, so it is not in the backend job registry and has
 * no run rows or health window.
 */
type ShowcaseFeedInvalidateRouteDependencies = {
  isAuthorizedCronRequest?: typeof isAuthorizedCronRequest;
  invalidateShowcaseFeedCache?: typeof invalidateShowcaseFeedCache;
  logEvent?: typeof logBackendEvent;
};

export async function getShowcaseFeedInvalidateRouteResponse({
  dependencies = {},
  request,
}: {
  dependencies?: ShowcaseFeedInvalidateRouteDependencies;
  request: Request;
}) {
  const isAuthorized = dependencies.isAuthorizedCronRequest ?? isAuthorizedCronRequest;
  const invalidate = dependencies.invalidateShowcaseFeedCache ?? invalidateShowcaseFeedCache;
  const logEvent = dependencies.logEvent ?? logBackendEvent;

  if (!isAuthorized(request)) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      request,
    );
  }

  const requestId = getApiRequestId(request);
  try {
    invalidate();
  } catch (error) {
    logEvent('error', 'showcase_feed_cache_invalidation_failed', {
      route: SHOWCASE_FEED_INVALIDATE_ROUTE,
      requestId,
      error,
    });
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Failed to refresh the feed cache.' }, { status: 500 }),
      request,
    );
  }

  logEvent('info', 'showcase_feed_cache_invalidated', {
    route: SHOWCASE_FEED_INVALIDATE_ROUTE,
    requestId,
  });
  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json({ success: true, invalidated: [SHOWCASE_FEED_CACHE_TAG, PUBLIC_PAGE_CACHE_TAG] }),
    request,
  );
}

export function createShowcaseFeedInvalidateRouteHandlers(
  dependencies?: ShowcaseFeedInvalidateRouteDependencies,
) {
  return {
    GET(request: Request) {
      return getShowcaseFeedInvalidateRouteResponse({ dependencies, request });
    },
  };
}
