import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  verifyPostResourceBundlePaymentForRoute,
  type PostResourceBundleVerifyRouteResult,
} from '@/lib/post-resource-bundle-verify-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostResourceBundleVerifyRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  verifyPostResourceBundlePaymentForRoute?: typeof verifyPostResourceBundlePaymentForRoute;
};

function resolveDependencies(dependencies: PostResourceBundleVerifyRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    verifyPostResourceBundlePaymentForRoute:
      dependencies?.verifyPostResourceBundlePaymentForRoute ?? verifyPostResourceBundlePaymentForRoute,
  };
}

function toJsonResponse(result: PostResourceBundleVerifyRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handlePostResourceBundleVerifyPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request) as SupabaseClient;
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return toJsonResponse(await dependencies.verifyPostResourceBundlePaymentForRoute({
    adminSupabase: dependencies.createServiceClient(),
    buyerUserId: user.id,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    readBody: () => request.json(),
  }));
}

export async function postPostResourceBundleVerifyRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: PostResourceBundleVerifyRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);

  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostResourceBundleVerifyPOST(request, resolvedDependencies),
    request,
  );
}
