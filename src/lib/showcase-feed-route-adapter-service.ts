import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { after, NextResponse } from 'next/server';

import {
  applyPrivateNoStoreApiResponseHeaders,
  createApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_FEED_READ_RATE_LIMIT,
  SHOWCASE_FOR_YOU_FEED_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  refundBackendRateLimit,
  type BackendRateLimitState,
} from '@/lib/backend-rate-limit';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { IDENTITY_PROXY_TIMING_HEADER } from '@/lib/identity-admission-assertion';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  getFeedNetworkKeyHash,
  isSameSiteBrowserFetch,
  resolveFeedAnonymousIdentity,
  setFeedAnonymousCookie,
} from '@/lib/showcase-feed-identity';
import {
  SHOWCASE_PAGE_SIZE,
  normalizeShowcaseCategory,
  normalizeShowcaseOffset,
  normalizeShowcaseResourceFilter,
  normalizeShowcaseSort,
  normalizeShowcaseUnlockFilter,
  parsePositiveInt,
  sanitizeShowcaseFeedPage,
} from '@/lib/showcase';
import { getShowcaseFeedPage, prepareShowcaseFeedReadAhead } from '@/lib/showcase-feed';
import { isShowcaseFeedReadAheadToken } from '@/lib/showcase-feed-read-ahead';
import {
  recordShowcaseFeedReadAheadEvent,
  type ShowcaseFeedReadAheadEvent,
} from '@/lib/showcase-feed-read-ahead-counts';
import type { RunAfterResponse } from '@/lib/deferrable-notification';

type ShowcaseFeedRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  refundBackendRateLimit?: typeof refundBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  resolveFeedAnonymousIdentity?: typeof resolveFeedAnonymousIdentity;
  getShowcaseFeedPage?: typeof getShowcaseFeedPage;
  prepareShowcaseFeedReadAhead?: typeof prepareShowcaseFeedReadAhead;
  recordShowcaseFeedReadAheadEvent?: (event: ShowcaseFeedReadAheadEvent) => Promise<void>;
  runAfterResponse?: RunAfterResponse;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: ShowcaseFeedRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    refundBackendRateLimit: dependencies?.refundBackendRateLimit ?? refundBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    resolveFeedAnonymousIdentity: dependencies?.resolveFeedAnonymousIdentity ?? resolveFeedAnonymousIdentity,
    getShowcaseFeedPage: dependencies?.getShowcaseFeedPage ?? getShowcaseFeedPage,
    // Read when a read-ahead arrives, not here: a request that is not one never needs it.
    prepareShowcaseFeedReadAhead: dependencies?.prepareShowcaseFeedReadAhead
      ?? ((options: Parameters<typeof prepareShowcaseFeedReadAhead>[0]) => prepareShowcaseFeedReadAhead(options)),
    recordShowcaseFeedReadAheadEvent: dependencies?.recordShowcaseFeedReadAheadEvent
      ?? ((event: ShowcaseFeedReadAheadEvent) => recordShowcaseFeedReadAheadEvent(event)),
    runAfterResponse: dependencies?.runAfterResponse ?? ((task) => after(task)),
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function getViewerUserId(
  request: Request,
  hasAuthorizationHeader: boolean,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!hasAuthorizationHeader) {
    return { ok: true as const, viewerUserId: null };
  }

  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error,
    } = await getVerifiedAuthUserResult(supabase);
    if (error || !user?.id) return { ok: false as const };
    return { ok: true as const, viewerUserId: user.id };
  } catch {
    return { ok: false as const };
  }
}

/** The parts of a feed read's address the route reads before it counts the read. */
type ShowcaseFeedReadQuery = {
  limit: number;
  tool: string | null;
  cursor: string | null;
  sort: ReturnType<typeof normalizeShowcaseSort>;
  offset: number;
  readAhead: boolean;
};

function readShowcaseFeedQuery(searchParams: URLSearchParams): ShowcaseFeedReadQuery {
  const limit = Math.min(parsePositiveInt(searchParams.get('limit'), SHOWCASE_PAGE_SIZE), 24);
  const cursor = searchParams.get('cursor');
  return {
    limit,
    tool: searchParams.get('tool'),
    cursor,
    sort: normalizeShowcaseSort(searchParams.get('sort')),
    offset: cursor ? 0 : normalizeShowcaseOffset(searchParams.get('offset'), searchParams.get('page'), limit),
    readAhead: searchParams.get('readAhead') === '1',
  };
}

/**
 * Explore's read-ahead (the app, once Home has settled): a signed-in viewer's ranked first page,
 * ranked now and held without a write, for the read that shows it to claim with its token.
 * Anything else asking for one is refused, before it is counted, rather than answered with an
 * ordinary page, which would open a session and mark its posts served for a page nobody is
 * looking at.
 */
function refusesReadAhead(query: ShowcaseFeedReadQuery, viewerUserId: string | null): boolean {
  return query.readAhead
    && (query.sort !== 'for-you' || Boolean(query.cursor) || query.offset !== 0 || !viewerUserId);
}

/**
 * Every sort is limited, not just for-you. The others were left open on the reasoning that they
 * are cheap cached reads, but `top-sales` scans every public post per call, and an unthrottled
 * expensive read is exactly what an abusive client will find. The non-personalized ceiling is
 * deliberately four times the for-you one: it is there to stop a script, not to shape browsing.
 */
function showcaseFeedReadRateLimit(sort: ShowcaseFeedReadQuery['sort']) {
  return sort === 'for-you' ? SHOWCASE_FOR_YOU_FEED_READ_RATE_LIMIT : SHOWCASE_FEED_READ_RATE_LIMIT;
}

type ShowcaseFeedReadLimitOutcome =
  | { allowed: true; state: BackendRateLimitState; durationMs: number }
  | { allowed: false; error: unknown; durationMs: number };

/** A signed-in read's count, started beside admission's lifecycle round trip. */
export type StartedShowcaseFeedReadLimit = {
  scope: string;
  key: string;
  /** Settles once the count is in, with the limiter's answer or its error; never rejects. */
  settled: Promise<ShowcaseFeedReadLimitOutcome>;
  /** The handler's read of the count at its limit step: the count then stands, whatever it says. */
  claim: () => Promise<ShowcaseFeedReadLimitOutcome>;
  /**
   * Run once the request has been answered (`route-owned-identity-admission.ts`): gives the count
   * back when the handler never claimed it (admission refused the read, or the handler answered
   * before its limit step), so such a read spends nothing, as before the count moved. Waits for
   * the count first; never rejects.
   */
  release: () => Promise<void>;
};

/**
 * Count a signed-in read against its read limit from the token's locally verified subject while
 * admission's lifecycle round trip is still out (`app/api/showcase/feed/route.ts`), so the read
 * waits for the slower of the two instead of both. It counts what the handler below would count
 * for that viewer, under the same scope, limit, window and key, and nothing for a read the
 * handler refuses before counting (a read-ahead it will not serve). The handler reads the answer
 * only once admission has passed (`claim`). A read the handler never claims, because admission
 * refused it or the handler answered first, gets its count back after the answer (`release`,
 * through `refund_backend_rate_limit`), so it spends nothing, as before the count moved. Null when
 * nothing was started; the handler then counts the read itself.
 */
export function startShowcaseFeedReadLimit(
  request: Request,
  viewerUserId: string,
  dependencies?: ShowcaseFeedRouteDependencies,
): StartedShowcaseFeedReadLimit | null {
  const resolved = resolveDependencies(dependencies);
  const query = readShowcaseFeedQuery(new URL(request.url).searchParams);
  if (refusesReadAhead(query, viewerUserId)) return null;
  const readRateLimit = showcaseFeedReadRateLimit(query.sort);
  let serviceClient: ReturnType<typeof createServiceClient>;
  try {
    serviceClient = resolved.createServiceClient();
  } catch {
    // The handler meets the same failure in its own count and answers it as it always has.
    return null;
  }
  const startedAt = performance.now();
  const settled = new Promise<BackendRateLimitState>((resolve) => {
    // In the executor, so a dependency that throws instead of rejecting settles as a failure too.
    resolve(resolved.enforceBackendRateLimit(serviceClient, { ...readRateLimit, key: viewerUserId }));
  }).then(
    (state): ShowcaseFeedReadLimitOutcome => ({ allowed: true, state, durationMs: performance.now() - startedAt }),
    (error: unknown): ShowcaseFeedReadLimitOutcome => ({
      allowed: false,
      error,
      durationMs: performance.now() - startedAt,
    }),
  );
  let claimed = false;
  let released = false;
  return {
    scope: readRateLimit.scope,
    key: viewerUserId,
    settled,
    claim: () => {
      claimed = true;
      return settled;
    },
    release: async () => {
      // Once, whoever calls it and however often: a count is given back at most once.
      if (claimed || released) return;
      released = true;
      const outcome = await settled;
      if (claimed) return;
      // The count is in whenever the limiter answered, allowed or over the limit. A failed check
      // may never have counted, so nothing is given back for it.
      const counted = outcome.allowed
        ? outcome.state
        : outcome.error instanceof BackendRateLimitError ? outcome.error.state : null;
      if (!counted) return;
      try {
        await resolved.refundBackendRateLimit(serviceClient, {
          scope: readRateLimit.scope,
          key: viewerUserId,
          windowSeconds: readRateLimit.windowSeconds,
          resetAt: counted.resetAt,
        });
      } catch (error) {
        // The read stays counted: its account sees one more read in this window than it made.
        resolved.logError('Showcase feed read limit refund failed:', error);
      }
    },
  };
}

async function handleShowcaseFeedGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
  startedReadLimit: StartedShowcaseFeedReadLimit | null,
) {
  try {
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const performanceMonitorMode = request.headers.get('x-performance-monitor');
    const timingEnabled = process.env.SCALING_CERTIFICATION_TIMINGS === '1'
      || hasAuthorizationHeader
        && (performanceMonitorMode === 'warmup' || performanceMonitorMode === 'load');
    const phaseTimings = new Map<string, number>();
    const recordPhase = (phase: string, durationMs: number) => {
      if (!timingEnabled) return;
      phaseTimings.set(phase, (phaseTimings.get(phase) ?? 0) + Math.max(0, durationMs));
    };
    const withPhaseTimings = (response: NextResponse) => {
      if (!timingEnabled) return response;
      const renderedTimings = [...phaseTimings]
        .map(([phase, durationMs]) => `${phase.replace(/_/g, '-')};dur=${durationMs.toFixed(2)}`)
        .join(', ');
      response.headers.set('Server-Timing', renderedTimings);
      // Vercel preview protection may consume or strip Server-Timing. Keep a
      // mirror for the authenticated production monitor so the external driver
      // can diagnose a tail without exposing timings on ordinary public reads.
      response.headers.set('x-scaling-certification-timing', renderedTimings);
      return response;
    };
    // Explore's read-ahead counts (`showcase-feed-read-ahead-counts.ts`), kept
    // once the answer has gone. A count that cannot be scheduled is lost; the
    // read it counts never is.
    const countReadAhead = (event: ShowcaseFeedReadAheadEvent) => {
      try {
        dependencies.runAfterResponse(() => dependencies.recordShowcaseFeedReadAheadEvent(event));
      } catch (error) {
        dependencies.logError('Showcase feed read-ahead count failed:', error);
      }
    };
    if (timingEnabled) {
      // Admission can run in the proxy or in the regional route handler.
      for (const entry of request.headers.get(IDENTITY_PROXY_TIMING_HEADER)?.split(',') ?? []) {
        const proxyTiming = entry.trim().match(/^((?:proxy|route)-[a-z]+(?:-[a-z]+)*);dur=(\d+(?:\.\d+)?)$/u);
        if (proxyTiming) recordPhase(proxyTiming[1].replace(/-/g, '_'), Number(proxyTiming[2]));
      }
    }
    const searchParams = new URL(request.url).searchParams;
    const query = readShowcaseFeedQuery(searchParams);
    const { limit, tool, cursor, sort, offset, readAhead } = query;
    const authStartedAt = performance.now();
    const actor = await getViewerUserId(request, hasAuthorizationHeader, dependencies);
    recordPhase('auth', performance.now() - authStartedAt);
    if (!actor.ok) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }
    const viewerUserId = actor.viewerUserId;
    if (refusesReadAhead(query, viewerUserId)) {
      return NextResponse.json(
        {
          error: 'Only a signed-in first page of a ranked lane can be read ahead.',
          code: 'READ_AHEAD_UNSUPPORTED',
        },
        { status: 400, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }
    // The seed bucket the reader's previous For you page named, sent back
    // when it pages on by offset; the ranking checks it is recent.
    const seedBucketParam = searchParams.get('seedBucket');
    const seedBucket = sort === 'for-you' && !cursor && seedBucketParam && /^\d{1,12}$/.test(seedBucketParam)
      ? Number(seedBucketParam)
      : null;
    const readAheadTokenParam = searchParams.get('readAheadToken');
    const readAheadToken = sort === 'for-you' && !cursor && offset === 0
      && isShowcaseFeedReadAheadToken(readAheadTokenParam)
      ? readAheadTokenParam
      : null;
    // The reader's own refresh of a For you first page (a pull, "New posts"):
    // ranked afresh, where a first page read again within two minutes is
    // otherwise served the same ranking. Anything else ignores it.
    const fresh = searchParams.get('fresh') === '1' && sort === 'for-you' && !cursor && offset === 0;
    const anonymousIdentity = viewerUserId || sort !== 'for-you'
      ? null
      : dependencies.resolveFeedAnonymousIdentity(request);
    // A caller with no identity at all (no feed cookie and no installation id)
    // that is not a browser fetching from our own pages: a script, crawler or
    // unfurler. It would get a fresh id on every request, and with each one a
    // ranked session and delivery facts nobody comes back to (usage audit,
    // 2026-11-04). It gets the shared first page instead, ranked once for every
    // identity-less reader and cached, and nothing is persisted for it. The
    // cookie is still offered, so a client that keeps it is an anonymous-cookie
    // viewer from its next request on. A browser's own first fetch keeps the
    // ranked, logged path: it is a person's first page, and the training data
    // and its Load more cursor both start there.
    const identityless = Boolean(anonymousIdentity?.cookieValueToSet)
      && !isSameSiteBrowserFetch(request);
    const anonymousKeyHash = identityless ? null : anonymousIdentity?.anonymousKeyHash ?? null;

    // Every read is counted against its read limit before any feed work. A signed-in read is
    // normally counted already, beside admission's lifecycle round trip: that count is read
    // here when it was made under the limit and key this step would use (both come from the same
    // address and the same verified subject, so it always is), and answered exactly as this
    // step's own count would be. Otherwise the read is counted here, as it always was, and the
    // count started beside admission, never claimed, is given back after the answer.
    {
      const limiterStartedAt = performance.now();
      const readRateLimit = showcaseFeedReadRateLimit(sort);
      let limitFailure: { error: unknown } | null = null;
      if (
        viewerUserId
        && startedReadLimit?.key === viewerUserId
        && startedReadLimit.scope === readRateLimit.scope
      ) {
        const outcome = await startedReadLimit.claim();
        // What admission's round trip did not already cover.
        recordPhase('rate_limit_wait', performance.now() - limiterStartedAt);
        if (outcome.allowed) recordPhase('rate_limit', outcome.durationMs);
        else limitFailure = { error: outcome.error };
      } else {
        const serviceClient = dependencies.createServiceClient();
        try {
          await dependencies.enforceBackendRateLimit(serviceClient, {
            ...readRateLimit,
            key: viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
          });
          recordPhase('rate_limit', performance.now() - limiterStartedAt);
        } catch (error) {
          limitFailure = { error };
        }
      }
      if (limitFailure) {
        if (limitFailure.error instanceof BackendRateLimitError) {
          return applyPrivateNoStoreApiResponseHeaders(createBackendRateLimitResponse(limitFailure.error), request);
        }
        dependencies.logError('Showcase feed rate limit failed:', limitFailure.error);
        return NextResponse.json(
          { error: 'Failed to check feed request limits.' },
          { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
        );
      }
    }

    if (readAhead) {
      const feedStartedAt = performance.now();
      const prepared = await dependencies.prepareShowcaseFeedReadAhead({
        category: normalizeShowcaseCategory(searchParams.get('category')),
        viewerUserId,
        tool: tool && tool !== 'all' ? tool : null,
        unlock: normalizeShowcaseUnlockFilter(searchParams.get('unlock')),
        resource: normalizeShowcaseResourceFilter(searchParams.get('resource')),
        ...(timingEnabled ? { onPhaseTiming: recordPhase } : {}),
      });
      recordPhase('feed_total', performance.now() - feedStartedAt);
      if (prepared) countReadAhead('hold');
      // Null: nothing to hold (no active algorithm, an empty ranking). The app
      // then reads the page the ordinary way when Explore opens.
      return withPhaseTimings(NextResponse.json(
        { readAhead: prepared },
        { headers: createPrivateNoStoreApiResponseHeaders(request) },
      ));
    }

    const feedStartedAt = performance.now();
    const feed = await dependencies.getShowcaseFeedPage({
      category: normalizeShowcaseCategory(searchParams.get('category')),
      sort,
      offset,
      limit,
      viewerUserId,
      anonymousKeyHash,
      cursor,
      requestId: getApiRequestId(request),
      tool: tool && tool !== 'all' ? tool : null,
      unlock: normalizeShowcaseUnlockFilter(searchParams.get('unlock')),
      resource: normalizeShowcaseResourceFilter(searchParams.get('resource')),
      countryCode: request.headers.get('x-vercel-ip-country'),
      // The cached feed contains viewer-neutral data. Saved/purchased state is
      // attached after the cache read, so authenticated readers can safely
      // share the same base page instead of rebuilding it per request. An
      // identity-less For you first page is the cached bootstrap.
      bypassCache: (sort === 'for-you' && !identityless) || Boolean(cursor),
      ...(readAheadToken ? { readAheadToken } : {}),
      // Counted only for a reader with an account, a guest's included, as every
      // hold is: a token sent without one is never the app's (it reads ahead
      // only with a bearer token), so it cannot land among the misses.
      ...(readAheadToken && viewerUserId
        ? { onReadAheadClaim: (claimed: boolean) => countReadAhead(claimed ? 'claim' : 'claim_miss') }
        : {}),
      ...(seedBucket === null ? {} : { seedBucket }),
      ...(fresh ? { fresh } : {}),
      ...(timingEnabled ? { onPhaseTiming: recordPhase } : {}),
    });
    recordPhase('feed_total', performance.now() - feedStartedAt);
    const cacheControl = getViewerAwareApiCacheControl(hasAuthorizationHeader || sort === 'for-you');

    const serializationStartedAt = performance.now();
    const response = NextResponse.json({
      ...sanitizeShowcaseFeedPage(feed),
      // Tells the app this server holds a read-ahead without writing it, and
      // so that it may send `readAhead=1`. A server without the mode would
      // answer that with an ordinary page, served to nobody, so the app asks
      // only one that has said this (on its own For you pages).
      ...(sort === 'for-you' && viewerUserId ? { readAheadSupported: true } : {}),
    }, {
      headers: createApiResponseHeaders(request, cacheControl, {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
    recordPhase('serialization', performance.now() - serializationStartedAt);
    withPhaseTimings(response);
    if (anonymousIdentity?.cookieValueToSet) {
      setFeedAnonymousCookie(response, anonymousIdentity.cookieValueToSet);
    }
    return response;
  } catch (error) {
    dependencies.logError('Showcase feed error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch showcase feed' },
      { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
    );
  }
}

export async function getShowcaseFeedRouteResponse({
  dependencies,
  request,
  startedReadLimit = null,
}: {
  dependencies?: ShowcaseFeedRouteDependencies;
  request: Request;
  /** This read's count, when the route started it beside admission (`startShowcaseFeedReadLimit`). */
  startedReadLimit?: StartedShowcaseFeedReadLimit | null;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleShowcaseFeedGET(request, resolvedDependencies, startedReadLimit)
  ));
}
