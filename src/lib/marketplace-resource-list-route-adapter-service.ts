import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  API_CACHE_CONTROL,
  createApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  normalizeMarketplaceResourceFilter,
  normalizeMarketplaceResourceKindFilter,
  normalizeMarketplaceResourceSort,
} from '@/lib/post-resource-bundles';
import { getMarketplaceResourceList } from '@/lib/post-resource-bundles-server';
import { MARKETPLACE_DEFAULT_PAGE_SIZE } from '@/lib/marketplace-resource-list-cache-policy';
import {
  isValidMarketplaceSearchQuery,
  MARKETPLACE_SEARCH_MIN_LENGTH,
  normalizeMarketplaceSearchQuery,
} from '@/lib/marketplace-search-policy';
import { IDENTITY_PROXY_TIMING_HEADER } from '@/lib/identity-admission-assertion';
import {
  filterMarketplaceItemsForViewer,
  readMarketplaceViewerBlocks,
} from '@/lib/marketplace-viewer-filter';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createUserClient } from '@/lib/server-helpers';
import { slugifySourceTool } from '@/lib/source-tools';

type MarketplaceResourceListRouteDependencies = {
  createUserClient?: typeof createUserClient;
  filterMarketplaceItemsForViewer?: typeof filterMarketplaceItemsForViewer;
  getMarketplaceResourceList?: typeof getMarketplaceResourceList;
  readMarketplaceViewerBlocks?: (viewerUserId: string) => ReturnType<typeof readMarketplaceViewerBlocks>;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

export const MAX_MARKETPLACE_RESOURCE_OFFSET = 960;

function resolveDependencies(dependencies: MarketplaceResourceListRouteDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    filterMarketplaceItemsForViewer:
      dependencies?.filterMarketplaceItemsForViewer ?? filterMarketplaceItemsForViewer,
    getMarketplaceResourceList: dependencies?.getMarketplaceResourceList ?? getMarketplaceResourceList,
    readMarketplaceViewerBlocks: dependencies?.readMarketplaceViewerBlocks
      ?? ((viewerUserId: string) => readMarketplaceViewerBlocks(viewerUserId)),
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

/**
 * Where a signed-in list read spends its time, for the production monitor and a scaling run only,
 * as the feed reports it: the proxy's identity admission (`proxy-identity`, `-verify`,
 * `-lifecycle`, which the proxy forwards under the same condition) and this route's own reads. A
 * signed-in read took about 1.5 s live while a signed-out one the edge did not answer took 0.2 to
 * 0.5 s (live sweep, 2026-11-17); this says which part. Never sent on an ordinary read.
 */
function createPhaseTimings(request: Request, hasAuthorizationHeader: boolean) {
  const monitorMode = request.headers.get('x-performance-monitor');
  const enabled = process.env.SCALING_CERTIFICATION_TIMINGS === '1'
    || hasAuthorizationHeader && (monitorMode === 'warmup' || monitorMode === 'load');
  const phases = new Map<string, number>();
  if (enabled) {
    for (const entry of request.headers.get(IDENTITY_PROXY_TIMING_HEADER)?.split(',') ?? []) {
      const proxyTiming = entry.trim().match(/^(proxy-[a-z]+);dur=(\d+(?:\.\d+)?)$/u);
      if (proxyTiming) phases.set(proxyTiming[1], Number(proxyTiming[2]));
    }
  }

  return {
    /** Times one read under `phase`, when timings are asked for. */
    measure<T>(phase: string, read: Promise<T>): Promise<T> {
      if (!enabled) return read;
      const startedAt = performance.now();
      return read.finally(() => phases.set(phase, performance.now() - startedAt));
    },
    apply(response: NextResponse): NextResponse {
      if (!enabled) return response;
      const rendered = [...phases].map(([phase, durationMs]) => `${phase};dur=${durationMs.toFixed(2)}`).join(', ');
      response.headers.set('Server-Timing', rendered);
      // Kept beside it, as the feed keeps it: Vercel's preview protection may strip Server-Timing.
      response.headers.set('x-scaling-certification-timing', rendered);
      return response;
    },
  };
}

function normalizeNumber(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

async function getViewerUserId(
  request: Request,
  hasAuthorizationHeader: boolean,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!hasAuthorizationHeader) return null;

  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
  } = await getVerifiedAuthUserResult(supabase);
  return user?.id ?? null;
}

async function handleMarketplaceResourceListGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const offset = normalizeNumber(searchParams.get('offset'), 0);
    if (offset > MAX_MARKETPLACE_RESOURCE_OFFSET) {
      return NextResponse.json(
        { error: `offset must be at most ${MAX_MARKETPLACE_RESOURCE_OFFSET}.` },
        {
          status: 400,
          headers: createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore),
        },
      );
    }

    const query = normalizeMarketplaceSearchQuery(searchParams.get('q'));
    if (!isValidMarketplaceSearchQuery(query)) {
      return NextResponse.json(
        { error: `q must be empty or at least ${MARKETPLACE_SEARCH_MIN_LENGTH} characters.` },
        {
          status: 400,
          headers: createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore),
        },
      );
    }

    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const timings = createPhaseTimings(request, hasAuthorizationHeader);
    const viewerUserIdRead = timings.measure('route-viewer', getViewerUserId(request, hasAuthorizationHeader, dependencies));
    // A signed-in viewer's blocks are theirs, not the page's, so they are read beside the page
    // rather than after it, where they cost every signed-in read a round trip of their own (live
    // sweep, 2026-11-17). The viewer comes from the proxy's admission at once.
    const viewerBlocksRead = viewerUserIdRead.then((viewerUserId) => (
      viewerUserId ? timings.measure('route-blocks', dependencies.readMarketplaceViewerBlocks(viewerUserId)) : null
    ));
    const [cachedPage, viewerUserId, viewerBlocks] = await Promise.all([
      timings.measure('route-list', dependencies.getMarketplaceResourceList({
        filter: normalizeMarketplaceResourceFilter(searchParams.get('access')),
        resource: normalizeMarketplaceResourceKindFilter(searchParams.get('resource')),
        tool: slugifySourceTool(searchParams.get('tool') ?? undefined),
        q: query,
        sort: normalizeMarketplaceResourceSort(searchParams.get('sort')),
        offset,
        limit: Math.min(48, Math.max(1, normalizeNumber(
          searchParams.get('limit'),
          MARKETPLACE_DEFAULT_PAGE_SIZE,
        ))),
        countryCode: request.headers.get('x-vercel-ip-country'),
      })),
      viewerUserIdRead,
      viewerBlocksRead,
    ]);
    // pageInfo still counts the unfiltered list, so the next page starts where
    // this one ended even when blocked creators' recipes were taken out of it.
    const page = {
      ...cachedPage,
      items: await timings.measure(
        'route-filter',
        dependencies.filterMarketplaceItemsForViewer(cachedPage.items, viewerUserId, {}, { viewerBlocks }),
      ),
    };

    const boundedPage = page.pageInfo.nextOffset !== null
      && page.pageInfo.nextOffset > MAX_MARKETPLACE_RESOURCE_OFFSET
      ? {
          ...page,
          pageInfo: {
            ...page.pageInfo,
            hasMore: false,
            nextOffset: null,
          },
        }
      : page;

    // A signed-in page is filtered for its viewer, so it must never be served
    // from the shared edge copy, nor stored there.
    return timings.apply(NextResponse.json(boundedPage, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    }));
  } catch (error) {
    dependencies.logError('Failed to load marketplace resources:', error);
    return NextResponse.json({ error: 'Failed to load marketplace unlocks.' }, { status: 500 });
  }
}

export async function getMarketplaceResourceListRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MarketplaceResourceListRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleMarketplaceResourceListGET(request, resolvedDependencies)
  ));
}
