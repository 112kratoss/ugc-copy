import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  verifyMarketplacePaymentForRoute,
  type MarketplaceVerifyRouteResult,
} from '@/lib/marketplace-verify-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MarketplaceVerifyRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  logError?: typeof console.error;
  razorpayKeySecret?: string | null;
  verifyMarketplacePaymentForRoute?: typeof verifyMarketplacePaymentForRoute;
};

function resolveDependencies(dependencies: MarketplaceVerifyRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    logError: dependencies?.logError ?? console.error,
    razorpayKeySecret: dependencies && 'razorpayKeySecret' in dependencies
      ? dependencies.razorpayKeySecret
      : process.env.RAZORPAY_KEY_SECRET,
    verifyMarketplacePaymentForRoute:
      dependencies?.verifyMarketplacePaymentForRoute ?? verifyMarketplacePaymentForRoute,
  };
}

function toJsonResponse(result: MarketplaceVerifyRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleMarketplaceVerifyPOST({
  dependencies,
  request,
}: {
  dependencies: ReturnType<typeof resolveDependencies>;
  request: Request;
}) {
  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return toJsonResponse(await dependencies.verifyMarketplacePaymentForRoute({
      adminSupabase: dependencies.createServiceClient(),
      buyerUserId: user.id,
      keySecret: dependencies.razorpayKeySecret,
      readBody: () => request.json(),
    }));
  } catch (error) {
    dependencies.logError('Marketplace payment verification failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postMarketplaceVerifyRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MarketplaceVerifyRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMarketplaceVerifyPOST({
      dependencies: resolveDependencies(dependencies),
      request,
    }),
    request,
  );
}
