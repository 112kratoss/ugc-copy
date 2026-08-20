import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

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
  clientIntentKey?: unknown;
  planId?: unknown;
};

type RazorpayCreditOrderRouteDependencies = {
  createCreditRazorpayOrderForRoute?: typeof createCreditRazorpayOrderForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: RazorpayCreditOrderRouteDependencies | undefined) {
  return {
    createCreditRazorpayOrderForRoute:
      dependencies?.createCreditRazorpayOrderForRoute ?? createCreditRazorpayOrderForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    logError: dependencies?.logError ?? logBackendRouteError,
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
    const { clientIntentKey, planId } = await request.json() as RazorpayCreditOrderBody;

    if (!planId) {
      return NextResponse.json({ error: 'Missing planId' }, { status: 400 });
    }

    // Object.hasOwn keeps prototype keys ('constructor', '__proto__', …) from
    // resolving to a truthy non-plan value through the plain-object map.
    const plan = typeof planId === 'string' && Object.hasOwn(PRICING_PLAN_MAP, planId)
      ? PRICING_PLAN_MAP[planId as keyof typeof PRICING_PLAN_MAP]
      : undefined;
    if (!plan) {
      return NextResponse.json({ error: 'Invalid planId' }, { status: 400 });
    }

    const supabase = dependencies.createUserClient(request);
    const { data: { user }, error: authError } = await getVerifiedAuthUserResult(supabase);
    // Registered-only per route-identity-policy.ts. A guest holds a valid
    // JWT, so `!user` alone stopped meaning "not registered" the moment
    // anonymous sessions existed.
    if (authError || !user || isGuestUser(user)) {
      return NextResponse.json(
        { error: 'Unauthorized: Please log in to purchase credits.' },
        { status: 401 },
      );
    }

    return toJsonResponse(await dependencies.createCreditRazorpayOrderForRoute({
      adminSupabase: dependencies.createServiceClient(),
      clientIntentKey: typeof clientIntentKey === 'string' ? clientIntentKey : '',
      userId: user.id,
      plan,
    }));
  } catch (error: unknown) {
    // Detail stays in the structured log; clients get a fixed generic message
    // so provider/config internals never leak through this money path.
    dependencies.logError('Razorpay Order Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
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
