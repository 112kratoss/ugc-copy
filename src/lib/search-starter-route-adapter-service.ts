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
import { SEARCH_STARTER_EMPTY_RESPONSE, SEARCH_STARTER_RATE_LIMIT } from '@/lib/search-starter';
import { getSearchStarter } from '@/lib/search-starter-service';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';

type SearchStarterRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  getSearchStarter?: typeof getSearchStarter;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
  /** Where the kill switch is read from; `process.env` by default. */
  env?: Environment;
};

type Environment = Record<string, string | undefined>;

/**
 * `SEARCH_STARTER_DISABLED=1` (or `true`) is the kill switch: the route then
 * offers nothing, with no database call, and both search screens open as they
 * did before the starter (docs/production-deployment-runbook.md, "Search
 * Starter"). Read per request.
 */
export function isSearchStarterDisabled(env: Environment = process.env): boolean {
  const value = env.SEARCH_STARTER_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function resolveDependencies(dependencies?: SearchStarterRouteDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    getSearchStarter: dependencies?.getSearchStarter ?? getSearchStarter,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
    env: dependencies?.env ?? process.env,
  };
}

/**
 * As /api/search and /api/search/suggest resolve their viewer: no token is a
 * visitor; a token must be a live identity (the proxy has already refused an
 * agent's, a banned account's and a revoked session's on this public route),
 * a guest's included, and one that does not verify is a 401, never a quiet
 * fall back to the visitor's answer, which would offer a signed-in viewer the
 * creators they blocked.
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

async function handleSearchStarterGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const startedAt = performance.now();
  try {
    // Switched off: the answer with nothing to offer, for everyone, before a
    // token is verified or a row is read. Never the edge's to keep, so the
    // switch is felt the moment it is thrown and gone the moment it is lifted.
    if (isSearchStarterDisabled(dependencies.env)) {
      return NextResponse.json(SEARCH_STARTER_EMPTY_RESPONSE, {
        headers: createPrivateNoStoreApiResponseHeaders(request),
      });
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
        ...SEARCH_STARTER_RATE_LIMIT,
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
      dependencies.logError('Search starter rate limit failed:', error);
      return NextResponse.json(
        { error: 'Failed to check search starter request limits.' },
        { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
      );
    }

    const responseBody = await dependencies.getSearchStarter({ viewerUserId: actor.viewerUserId });
    // A token's answer is its viewer's (their blocks, their follows): private,
    // never stored. A visitor's is the same for every visitor, so the edge may
    // keep it for a few minutes (a minute fresh, five more while it is asked
    // again), apart from any token's by Vary: the repo's rule for a
    // viewer-aware public read (getViewerAwareApiCacheControl). No search-log
    // row is written.
    const response = NextResponse.json(responseBody, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization'],
      }),
    });
    if (process.env.SCALING_CERTIFICATION_TIMINGS === '1') {
      response.headers.set('Server-Timing', `search-starter;dur=${(performance.now() - startedAt).toFixed(2)}`);
    }
    return response;
  } catch (error) {
    dependencies.logError('Search starter failed:', error);
    return NextResponse.json(
      { error: 'Failed to load search starter.' },
      { status: 500, headers: createPrivateNoStoreApiResponseHeaders(request) },
    );
  }
}

export async function getSearchStarterRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: SearchStarterRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  return resolved.withProviderFetchRequestId(getApiRequestId(request), () => (
    handleSearchStarterGET(request, resolved)
  ));
}
