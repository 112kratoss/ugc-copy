import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { PRICING_PLAN_MAP } from '@/lib/pricing';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import {
  createCreditRazorpayOrderForRoute,
  type CreditRazorpayOrderRouteResult,
} from '@/lib/razorpay-credit-order-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RazorpayCreditOrderBody = {
  planId?: unknown;
};

type RazorpayCreditOrderRouteDependencies = {
  createCreditRazorpayOrderForRoute?: typeof createCreditRazorpayOrderForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  logError?: typeof console.error;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: RazorpayCreditOrderRouteDependencies | undefined) {
  return {
    createCreditRazorpayOrderForRoute:
      dependencies?.createCreditRazorpayOrderForRoute ?? createCreditRazorpayOrderForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    logError: dependencies?.logError ?? console.error,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function toJsonResponse(result: CreditRazorpayOrderRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleRazorpayCreditOrderPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { planId } = await request.json() as RazorpayCreditOrderBody;

    if (!planId) {
      return NextResponse.json({ error: 'Missing planId' }, { status: 400 });
    }

    const plan = PRICING_PLAN_MAP[planId as keyof typeof PRICING_PLAN_MAP];
    if (!plan) {
      return NextResponse.json({ error: 'Invalid planId' }, { status: 400 });
    }

    const supabase = dependencies.createUserClient(request);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized: Please log in to purchase credits.' },
        { status: 401 },
      );
    }

    return toJsonResponse(await dependencies.createCreditRazorpayOrderForRoute({
      adminSupabase: dependencies.createServiceClient(),
      userId: user.id,
      plan,
    }));
  } catch (error: unknown) {
    dependencies.logError('Razorpay Order Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}

export async function postRazorpayCreditOrderRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: RazorpayCreditOrderRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleRazorpayCreditOrderPOST(request, resolvedDependencies),
      request,
    )
  ));
}
