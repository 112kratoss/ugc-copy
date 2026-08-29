import 'server-only';

import { NextResponse } from 'next/server';

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
import { logBackendRouteError } from '@/lib/backend-logger';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';
import {
  PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH,
  PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH,
  decodePublicSearchCursor,
  isPublicSearchQueryTooLong,
  normalizeCreatorSearchQuery,
  parsePublicSearchLimit,
  parsePublicSearchType,
} from '@/lib/public-search';
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
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies?: PublicSearchRouteDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    searchPublicContent: dependencies?.searchPublicContent ?? searchPublicContent,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function resolveViewerUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!request.headers.get('Authorization')) {
    return { ok: true as const, viewerUserId: null };
  }

  try {
    const client = dependencies.createUserClient(request);
    const { data: { user }, error } = await getVerifiedAuthUserResult(client);
    if (error || !user?.id) return { ok: false as const, viewerUserId: null };
    return { ok: true as const, viewerUserId: user.id };
  } catch {
    return { ok: false as const, viewerUserId: null };
  }
}

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
  try {
    const url = new URL(request.url);
    const rawQuery = url.searchParams.get('q');
    if (isPublicSearchQueryTooLong(rawQuery)) {
      return badRequest(request, 'q must be at most 100 characters.');
    }
    const normalizedQuery = normalizeCreatorSearchQuery(rawQuery);
    if (normalizedQuery.length < PUBLIC_SEARCH_MIN_CREATOR_QUERY_LENGTH) {
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
      && normalizedQuery.length < PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH
    ) {
      return badRequest(
        request,
        `${type} search requires at least ${PUBLIC_SEARCH_MIN_CONTENT_QUERY_LENGTH} characters.`,
      );
    }

    const limit = parsePublicSearchLimit(url.searchParams.get('limit'));
    if (!limit) return badRequest(request, 'limit must be an integer between 1 and 24.');

    const rawCursor = url.searchParams.get('cursor');
    if (type === 'top' && rawCursor) return badRequest(request, 'Top search does not accept a cursor.');
    const cursor = rawCursor ? decodePublicSearchCursor(rawCursor, type) : null;
    if (rawCursor && !cursor) return badRequest(request, 'cursor is invalid for this search type.');

    const actor = await resolveViewerUserId(request, dependencies);
    if (!actor.ok) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...PUBLIC_SEARCH_READ_RATE_LIMIT,
        key: actor.viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
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
