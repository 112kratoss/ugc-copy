import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  CREDIT_UNLOCK_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  MobileCommerceError,
  unlockMarketplaceAssetWithCredits,
  unlockPostResourceBundleWithCredits,
  type MobileCommerceSyncResult,
} from '@/lib/mobile-commerce';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MarketplaceCreditUnlockRouteContext = {
  params: Promise<{ assetId: string }>;
};

type PostResourceCreditUnlockRouteContext = {
  params: Promise<{ postId: string }>;
};

type CreditUnlockRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof console.error;
  unlockMarketplaceAssetWithCredits?: typeof unlockMarketplaceAssetWithCredits;
  unlockPostResourceBundleWithCredits?: typeof unlockPostResourceBundleWithCredits;
};

type CreditUnlockRouteConfig =
  | {
    failureLogMessage: string;
    getResourceId: () => Promise<{ assetId: string }>;
    rateLimitFailureLogMessage: string;
    unlock: (input: {
      adminSupabase: SupabaseClient;
      resourceId: string;
      userId: string;
    }) => Promise<MobileCommerceSyncResult>;
  }
  | {
    failureLogMessage: string;
    getResourceId: () => Promise<{ postId: string }>;
    rateLimitFailureLogMessage: string;
    unlock: (input: {
      adminSupabase: SupabaseClient;
      resourceId: string;
      userId: string;
    }) => Promise<MobileCommerceSyncResult>;
  };

function resolveDependencies(dependencies: CreditUnlockRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? console.error,
  };
}

async function enforceCreditUnlockRateLimit(
  adminSupabase: SupabaseClient,
  userId: string,
  dependencies: ReturnType<typeof resolveDependencies>,
  rateLimitFailureLogMessage: string,
) {
  try {
    await dependencies.enforceBackendRateLimit(adminSupabase, {
      ...CREDIT_UNLOCK_RATE_LIMIT,
      key: userId,
    });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    dependencies.logError(rateLimitFailureLogMessage, error);
    return NextResponse.json({ error: 'Failed to check credit unlock limits.' }, { status: 500 });
  }
}

async function handleCreditUnlockPOST(
  request: Request,
  config: CreditUnlockRouteConfig,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const resource = await config.getResourceId();
    const resourceId = 'assetId' in resource ? resource.assetId : resource.postId;
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = dependencies.createServiceClient();
    const rateLimitResponse = await enforceCreditUnlockRateLimit(
      adminSupabase,
      user.id,
      dependencies,
      config.rateLimitFailureLogMessage,
    );
    if (rateLimitResponse) return rateLimitResponse;

    return NextResponse.json(await config.unlock({
      adminSupabase,
      resourceId,
      userId: user.id,
    }));
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    dependencies.logError(config.failureLogMessage, error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postMarketplaceCreditUnlockRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: MarketplaceCreditUnlockRouteContext;
  dependencies?: CreditUnlockRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const unlockMarketplace = dependencies?.unlockMarketplaceAssetWithCredits ?? unlockMarketplaceAssetWithCredits;
  return applyPrivateNoStoreApiResponseHeaders(
    await handleCreditUnlockPOST(request, {
      failureLogMessage: 'Marketplace credit unlock failed:',
      getResourceId: () => context.params,
      rateLimitFailureLogMessage: 'Marketplace credit unlock rate limit check failed:',
      unlock: ({ adminSupabase, resourceId, userId }) => (
        unlockMarketplace({
          adminSupabase,
          assetId: resourceId,
          userId,
        })
      ),
    }, resolvedDependencies),
    request,
  );
}

export async function postResourceBundleCreditUnlockRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostResourceCreditUnlockRouteContext;
  dependencies?: CreditUnlockRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  const unlockPostResourceBundle = dependencies?.unlockPostResourceBundleWithCredits ?? unlockPostResourceBundleWithCredits;
  return applyPrivateNoStoreApiResponseHeaders(
    await handleCreditUnlockPOST(request, {
      failureLogMessage: 'Post resource credit unlock failed:',
      getResourceId: () => context.params,
      rateLimitFailureLogMessage: 'Post resource credit unlock rate limit check failed:',
      unlock: ({ adminSupabase, resourceId, userId }) => (
        unlockPostResourceBundle({
          adminSupabase,
          postId: resourceId,
          userId,
        })
      ),
    }, resolvedDependencies),
    request,
  );
}
