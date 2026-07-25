import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  createApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  getPostResourceBundleDetailByPostId,
  resolvePostIdForResourceIdentifier,
} from '@/lib/post-resource-bundles-server';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createUserClient } from '@/lib/server-helpers';

type MarketplaceResourceDetailRouteContext = {
  params: Promise<{ resourceId: string }>;
};

type MarketplaceResourceDetailRouteDependencies = {
  createUserClient?: typeof createUserClient;
  getPostResourceBundleDetailByPostId?: typeof getPostResourceBundleDetailByPostId;
  logError?: typeof logBackendRouteError;
  resolvePostIdForResourceIdentifier?: typeof resolvePostIdForResourceIdentifier;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: MarketplaceResourceDetailRouteDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getPostResourceBundleDetailByPostId:
      dependencies?.getPostResourceBundleDetailByPostId ?? getPostResourceBundleDetailByPostId,
    logError: dependencies?.logError ?? logBackendRouteError,
    resolvePostIdForResourceIdentifier:
      dependencies?.resolvePostIdForResourceIdentifier ?? resolvePostIdForResourceIdentifier,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
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
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

async function handleMarketplaceResourceDetailGET(
  request: Request,
  context: MarketplaceResourceDetailRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { resourceId } = await context.params;
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const viewerUserId = await getViewerUserId(request, hasAuthorizationHeader, dependencies);

    const postId = await dependencies.resolvePostIdForResourceIdentifier(resourceId);
    if (!postId) {
      return NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
    }

    const bundle = await dependencies.getPostResourceBundleDetailByPostId(postId, {
      viewerUserId,
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    if (!bundle) {
      return NextResponse.json({ error: 'Unlock not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, bundle }, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
  } catch (error) {
    dependencies.logError('Marketplace resource detail error:', error);
    return NextResponse.json({ error: 'Failed to fetch marketplace unlock.' }, { status: 500 });
  }
}

export async function getMarketplaceResourceDetailRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: MarketplaceResourceDetailRouteContext;
  dependencies?: MarketplaceResourceDetailRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleMarketplaceResourceDetailGET(request, context, resolvedDependencies)
  ));
}
