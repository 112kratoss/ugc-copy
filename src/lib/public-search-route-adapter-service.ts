import 'server-only';

import { after, NextResponse } from 'next/server';

import {
  API_CACHE_CONTROL,
  createApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
  getApiRequestId,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  PUBLIC_SEARCH_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendEvent, logBackendRouteError } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import { isGuestUser } from '@/lib/account-identity';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';
import {
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  PUBLIC_SEARCH_PROBE_PARAM,
  PUBLIC_SEARCH_RELATED_PARAM,
  appliedPublicSearchFilters,
  decodePublicSearchCursor,
  isPublicSearchQueryTooLong,
  normalizeCreatorSearchQuery,
  appliedPublicSearchSort,
  parsePublicSearchLimit,
  parsePublicSearchSort,
  parsePublicSearchType,
  publicSearchCursorFilterMark,
  publicSearchQueryLength,
  readPublicSearchFilterParams,
} from '@/lib/public-search';
import { recordSearchAnswer } from '@/lib/public-search-query-log';
import { searchPublicContent } from '@/lib/public-search-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PublicSearchRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  searchPublicContent?: typeof searchPublicContent;
  logError?: typeof logBackendRouteError;
  /** The search log's failure line. */
  logEvent?: typeof logBackendEvent;
  /** Where the search log's insert goes once the answer is out; Next's `after` by default. */
  runAfterResponse?: RunAfterResponse;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

/**
 * Next's `after`, which takes a task only inside a request. Outside one (a test, a script) it
 * throws, and the task runs at once instead, in front of nothing.
 */
function runAfterResponseByDefault(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

function resolveDependencies(dependencies?: PublicSearchRouteDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    searchPublicContent: dependencies?.searchPublicContent ?? searchPublicContent,
    logError: dependencies?.logError ?? logBackendRouteError,
    logEvent: dependencies?.logEvent ?? logBackendEvent,
    runAfterResponse: dependencies?.runAfterResponse ?? runAfterResponseByDefault,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function resolveViewerUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!request.headers.get('Authorization')) {
    return { ok: true as const, viewerUserId: null, isGuest: false };
  }

  try {
    const client = dependencies.createUserClient(request);
    const { data: { user }, error } = await getVerifiedAuthUserResult(client);
    if (error || !user?.id) return { ok: false as const, viewerUserId: null, isGuest: false };
    return { ok: true as const, viewerUserId: user.id, isGuest: isGuestUser(user) };
  } catch {
    return { ok: false as const, viewerUserId: null, isGuest: false };
  }
}

// What each filter parameter may name, for the 400 that refuses another value.
const FILTER_PARAMETER_ERRORS = {
  madeWith: 'madeWith must be model:<key> or tool:<key>.',
  mediaKind: 'kind must be image or video.',
  hasRecipe: 'recipe must be 1.',
  following: 'following must be 1.',
  exact: 'exact must be 1.',
} as const;

function badRequest(request: Request, error: string) {
  return NextResponse.json(
    { error },
    { status: 400, headers: createPrivateNoStoreApiResponseHeaders(request) },
  );
}

async function handlePublicSearchGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const startedAt = performance.now();
  const requestedAt = new Date();
  try {
    const url = new URL(request.url);
    const rawQuery = url.searchParams.get('q');
    if (isPublicSearchQueryTooLong(rawQuery)) {
      return badRequest(request, 'q must be at most 100 characters.');
    }
    const normalizedQuery = normalizeCreatorSearchQuery(rawQuery);
    const queryLength = publicSearchQueryLength(normalizedQuery);
    if (queryLength < PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH) {
      return badRequest(
        request,
        `q must contain at least ${PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH} characters.`,
      );
    }

    const rawType = url.searchParams.get('type');
    const type = rawType === null ? 'top' : parsePublicSearchType(rawType);
    if (!type) return badRequest(request, 'type must be top, creators, posts, or recipes.');
    if (
      (type === 'posts' || type === 'recipes')
      && queryLength < PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH
    ) {
      return badRequest(
        request,
        `${type} search requires at least ${PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH} characters.`,
      );
    }

    // Any request may name a sort, so a client keeps one choice across tabs;
    // only Posts and Recipes are read in it. An unknown one is refused
    // whatever the type, as an unknown type is.
    const requestedSort = parsePublicSearchSort(url.searchParams.get('sort'));
    if (!requestedSort) return badRequest(request, 'sort must be top or latest.');
    const sort = appliedPublicSearchSort(type, requestedSort);

    // Filters and the exact reading are taken as a sort is: any request may
    // name them, so a client keeps its choices across tabs, an unknown value
    // is refused whatever the type, and only a Posts search is narrowed.
    const filterParams = readPublicSearchFilterParams((name) => url.searchParams.get(name));
    if (!filterParams.ok) return badRequest(request, FILTER_PARAMETER_ERRORS[filterParams.parameter]);

    // Related posts (search by meaning) are looked for only for a client that
    // asks: it draws them, and asks for a query a person settled on, never a
    // step of typing. Taken as the filters are: any request may name it, any
    // other value is refused whatever the type, and it changes nothing where
    // related posts do not apply (another tab, a later page, Latest, a filter,
    // the query read as typed).
    const rawRelated = url.searchParams.get(PUBLIC_SEARCH_RELATED_PARAM);
    if (rawRelated !== null && rawRelated !== '1') return badRequest(request, 'related must be 1.');
    // A search the client asks for itself (PUBLIC_SEARCH_PROBE_PARAM): answered
    // and limited as any, never written to the search log.
    const rawProbe = url.searchParams.get(PUBLIC_SEARCH_PROBE_PARAM);
    if (rawProbe !== null && rawProbe !== '1') return badRequest(request, 'probe must be 1.');

    const limit = parsePublicSearchLimit(url.searchParams.get('limit'));
    if (!limit) return badRequest(request, 'limit must be an integer between 1 and 24.');

    const rawCursor = url.searchParams.get('cursor');
    if (type === 'top' && rawCursor) return badRequest(request, 'Top search does not accept a cursor.');
    // A cursor pages the order it was issued for: one from Top is refused on Latest.
    const cursor = rawCursor ? decodePublicSearchCursor(rawCursor, type, sort) : null;
    if (rawCursor && !cursor) return badRequest(request, 'cursor is invalid for this search type and sort.');

    const actor = await resolveViewerUserId(request, dependencies);
    if (!actor.ok) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    // A registered account: most sessions here are guests, who follow nobody.
    const registered = actor.viewerUserId !== null && !actor.isGuest;
    // "From creators I follow" is left out for a visitor and for a guest
    // session, never refused: a filtered search's address still opens signed
    // out, and the answer says which filters it was read with.
    const filters = appliedPublicSearchFilters(type, filterParams.filters, registered);
    // A cursor pages the filters and the reading it was issued under, and no
    // other: its place in one list means nothing in another.
    if (
      cursor && type === 'posts'
      && cursor.filters !== publicSearchCursorFilterMark(filters, filterParams.exact)
    ) {
      return badRequest(request, 'cursor is invalid for these filters.');
    }

    const viewerKey = actor.viewerUserId ?? dependencies.getFeedNetworkKeyHash(request);
    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...PUBLIC_SEARCH_READ_RATE_LIMIT,
        key: viewerKey,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        const response = createBackendRateLimitResponse(error);
        for (const [name, value] of Object.entries(createPrivateNoStoreApiResponseHeaders(request))) {
          response.headers.set(name, value);
        }
        return response;
      }
      dependencies.logError('Public search rate limit failed:', error);
      return NextResponse.json(
        { error: 'Failed to check search request limits.' },
        { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    const responseBody = await dependencies.searchPublicContent({
      query: rawQuery?.trim() ?? normalizedQuery,
      normalizedQuery,
      type,
      sort,
      filters,
      exact: filterParams.exact,
      related: rawRelated === '1',
      // A new query's vector is counted against the same key as the request,
      // and a guest session's against its network too: a guest's id is new
      // with every anonymous sign-in, so its own key alone is no limit.
      viewerKey,
      guestNetworkKey: actor.isGuest ? dependencies.getFeedNetworkKeyHash(request) : null,
      cursor,
      limit,
      viewerUserId: actor.viewerUserId,
      countryCode: request.headers.get('x-vercel-ip-country'),
    });
    const response = NextResponse.json(responseBody, {
      headers: createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore, {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
    // The anonymous search log: scheduled behind the answer, never awaited,
    // never able to fail it; never for a search the person did not run (a probe).
    if (rawProbe === null) recordSearchAnswer({
      createClient: dependencies.createServiceClient,
      runAfterResponse: dependencies.runAfterResponse,
      logEvent: dependencies.logEvent,
    }, {
      hasCursor: cursor !== null,
      normalizedQuery,
      type,
      sort,
      filters,
      exact: filterParams.exact,
      viewerKey,
      // Most sessions here are guests, which the log does not call signed in.
      signedIn: registered,
      requestedAt,
      response: responseBody,
    });
    if (process.env.SCALING_CERTIFICATION_TIMINGS === '1') {
      response.headers.set('Server-Timing', `public-search;dur=${(performance.now() - startedAt).toFixed(2)}`);
    }
    return response;
  } catch (error) {
    dependencies.logError('Public search failed:', error);
    return NextResponse.json(
      { error: 'Failed to search public content.' },
      { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
    );
  }
}

export async function getPublicSearchRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: PublicSearchRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  return resolved.withProviderFetchRequestId(getApiRequestId(request), () => (
    handlePublicSearchGET(request, resolved)
  ));
}
