import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  isExternalServiceTimeoutError,
  withProviderFetchRequestId,
} from '@/lib/provider-fetch';
import { RazorpayOrderError } from '@/lib/razorpay-orders';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  createMarketplaceOrderForRoute,
  inferMarketplaceOrderCountryFromLocale,
  type MarketplaceOrderRouteResult,
} from '@/lib/marketplace-order-service';

type MarketplaceOrderRouteDependencies = {
  createMarketplaceOrderForRoute?: typeof createMarketplaceOrderForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: MarketplaceOrderRouteDependencies | undefined) {
  return {
    createMarketplaceOrderForRoute: dependencies?.createMarketplaceOrderForRoute
      ?? createMarketplaceOrderForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function toJsonResponse(result: MarketplaceOrderRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handleMarketplaceOrderPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await getVerifiedAuthUserResult(supabase);

    // Registered-only per route-identity-policy.ts. A guest holds a valid
    // JWT, so `!user` alone stopped meaning "not registered" the moment
    // anonymous sessions existed.
    if (authError || !user || isGuestUser(user)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
    const clientIntentKey = typeof body.clientIntentKey === 'string'
      ? body.clientIntentKey.trim()
      : '';
    const clientLocale = typeof body.locale === 'string' ? body.locale.trim() : null;

    if (!assetId) {
      return NextResponse.json({ error: 'Missing asset ID.' }, { status: 400 });
    }

    const countryCode =
      request.headers.get('x-vercel-ip-country')?.toUpperCase()
      ?? inferMarketplaceOrderCountryFromLocale(clientLocale);

    return toJsonResponse(await dependencies.createMarketplaceOrderForRoute({
      adminSupabase: dependencies.createServiceClient(),
      assetId,
      buyerUserId: user.id,
      clientIntentKey,
      countryCode,
    }));
  } catch (error) {
    dependencies.logError('Marketplace order creation failed:', error);
    if (isExternalServiceTimeoutError(error)) {
      return NextResponse.json({ error: 'Payment provider timed out. Please try again.' }, { status: 504 });
    }

    if (error instanceof RazorpayOrderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postMarketplaceOrderRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: MarketplaceOrderRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);

  return withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleMarketplaceOrderPOST(request, resolvedDependencies),
      request,
    )
  ));
}
