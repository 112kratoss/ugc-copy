import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  verifyCreditRazorpayPaymentForRoute,
  type CreditRazorpayVerifyRouteResult,
} from '@/lib/razorpay-credit-verify-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RazorpayCreditVerifyRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  getRazorpayKeyId?: () => string | undefined;
  getRazorpayKeySecret?: () => string | undefined;
  logError?: typeof logBackendRouteError;
  verifyCreditRazorpayPaymentForRoute?: typeof verifyCreditRazorpayPaymentForRoute;
};

function resolveDependencies(dependencies: RazorpayCreditVerifyRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getRazorpayKeyId: dependencies?.getRazorpayKeyId ?? (() => process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID),
    getRazorpayKeySecret: dependencies?.getRazorpayKeySecret ?? (() => process.env.RAZORPAY_KEY_SECRET),
    logError: dependencies?.logError ?? logBackendRouteError,
    verifyCreditRazorpayPaymentForRoute:
      dependencies?.verifyCreditRazorpayPaymentForRoute ?? verifyCreditRazorpayPaymentForRoute,
  };
}

function toJsonResponse(result: CreditRazorpayVerifyRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, {
    status: result.ok ? (result.status ?? 200) : result.status,
  });
}

async function handleRazorpayCreditVerifyPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    return toJsonResponse(await dependencies.verifyCreditRazorpayPaymentForRoute({
      keyId: dependencies.getRazorpayKeyId(),
      keySecret: dependencies.getRazorpayKeySecret(),
      readBody: () => request.json(),
      createUserSupabase: () => dependencies.createUserClient(request),
      createAdminSupabase: () => dependencies.createServiceClient(),
    }));
  } catch (error: unknown) {
    // Detail stays in the structured log; clients get a fixed generic message
    // so provider/config internals never leak through this money path.
    dependencies.logError('Razorpay Verify Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function postRazorpayCreditVerifyRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: RazorpayCreditVerifyRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleRazorpayCreditVerifyPOST(request, resolvedDependencies),
    request,
  );
}
