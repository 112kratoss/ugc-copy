import 'server-only';

import { NextResponse } from 'next/server';

import {
  createApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { logBackendRouteError } from '@/lib/backend-logger';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { SEARCH_SUGGEST_RATE_LIMIT, searchSuggestQuery } from '@/lib/search-suggest';
import { suggestSearch } from '@/lib/search-suggest-service';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';

type SearchSuggestRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  suggestSearch?: typeof suggestSearch;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
  /** Where the kill switch is read from; `process.env` by default. */
  env?: Environment;
};

type Environment = Record<string, string | undefined>;

/**
 * `SEARCH_SUGGEST_DISABLED=1` (or `true`) is the kill switch: the route then
 * offers nobody and nothing, with no database call, and the search box works
 * as it did before suggestions (docs/production-deployment-runbook.md,
 * "Search Suggestions"). Read per request.
 */
export function isSearchSuggestDisabled(env: Environment = process.env): boolean {
  const value = env.SEARCH_SUGGEST_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function resolveDependencies(dependencies?: SearchSuggestRouteDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    suggestSearch: dependencies?.suggestSearch ?? suggestSearch,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
    env: dependencies?.env ?? process.env,
  };
}

/**
 * As /api/search resolves its viewer: no token is a visitor; a token must be a
 * live identity (the proxy has already refused an agent's, a banned account's
 * and a revoked session's on this public route), a guest's included, and one
 * that does not verify is a 401, never a quiet fall back to the visitor's
 * answer, which would show a signed-in viewer the creators they blocked.
 */
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

async function handleSearchSuggestGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const startedAt = performance.now();
  try {
    const rawQuery = new URL(request.url).searchParams.get('q');
    const query = searchSuggestQuery(rawQuery);
    if (!query.ok) {
      return NextResponse.json(
        { error: query.error },
        { status: 400, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    // Switched off: the answer a query with no match gets, for everyone, before
    // a token is verified or a row is read. Never the edge's to keep, so the
    // switch is felt the moment it is thrown and gone the moment it is lifted.
    if (isSearchSuggestDisabled(dependencies.env)) {
      return NextResponse.json(
        { query: query.query, normalizedQuery: query.normalizedQuery, creators: [], entities: [], completions: [] },
        { headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const actor = await resolveViewerUserId(request, dependencies);
    if (!actor.ok) {
      return NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...SEARCH_SUGGEST_RATE_LIMIT,
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
      dependencies.logError('Search suggest rate limit failed:', error);
      return NextResponse.json(
        { error: 'Failed to check suggestion request limits.' },
        { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    const responseBody = await dependencies.suggestSearch({
      query: query.query,
      normalizedQuery: query.normalizedQuery,
      handlesOnly: query.handlesOnly,
      viewerUserId: actor.viewerUserId,
    });
    // A token's answer is its viewer's (their follows, their blocks): private,
    // never stored. A visitor's is the same for every visitor, so the edge may
    // keep it for a minute, apart from any token's by Vary: the repo's rule for
    // a viewer-aware public read (getViewerAwareApiCacheControl). No search-log
    // row is written for a suggestion, with or without a token.
    const response = NextResponse.json(responseBody, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization'],
      }),
    });
    if (process.env.SCALING_CERTIFICATION_TIMINGS === '1') {
      response.headers.set('Server-Timing', `search-suggest;dur=${(performance.now() - startedAt).toFixed(2)}`);
    }
    return response;
  } catch (error) {
    dependencies.logError('Search suggest failed:', error);
    return NextResponse.json(
      { error: 'Failed to load search suggestions.' },
      { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
    );
  }
}

export async function getSearchSuggestRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: SearchSuggestRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  return resolved.withProviderFetchRequestId(getApiRequestId(request), () => (
    handleSearchSuggestGET(request, resolved)
  ));
}
