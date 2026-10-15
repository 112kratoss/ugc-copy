import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';
import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  CREDIT_UNLOCK_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { isPostResourceBundleBuyWithheld } from '@/lib/marketplace-viewer-filter';
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

type RunAfterResponse = (task: () => Promise<unknown>) => void;

type CreditUnlockRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  isPostResourceBundleBuyWithheld?: typeof isPostResourceBundleBuyWithheld;
  logError?: typeof logBackendRouteError;
  runAfterResponse?: RunAfterResponse;
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
    logError: dependencies?.logError ?? logBackendRouteError,
    runAfterResponse: dependencies?.runAfterResponse ?? ((task) => after(task)),
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
    } = await getVerifiedAuthUserResult(supabase);

    // Registered-only per route-identity-policy.ts. A guest holds a valid
    // JWT, so `!user` alone stopped meaning "not registered" the moment
    // anonymous sessions existed.
    if (authError || !user || isGuestUser(user)) {
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
      // A refusal the buyer can act on (the 402's price and spendable balance)
      // carries its fields beside the message.
      return NextResponse.json({ ...error.details, error: error.message }, { status: error.status });
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
          // As for the post resource unlock below: the pushes go out behind
          // the answer rather than in front.
          runAfterResponse: resolvedDependencies.runAfterResponse,
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
  const isBuyWithheld = dependencies?.isPostResourceBundleBuyWithheld ?? isPostResourceBundleBuyWithheld;
  return applyPrivateNoStoreApiResponseHeaders(
    await handleCreditUnlockPOST(request, {
      failureLogMessage: 'Post resource credit unlock failed:',
      getResourceId: () => context.params,
      rateLimitFailureLogMessage: 'Post resource credit unlock rate limit check failed:',
      unlock: async ({ adminSupabase, resourceId, userId }) => {
        // The spend RPC checks only the bundle's status. What the detail read
        // would not show this buyer, or a creator either of them has blocked,
        // is answered as the RPC answers a missing unlock: nothing is spent
        // and nobody is notified.
        if (await isBuyWithheld({ adminSupabase, buyerUserId: userId, postId: resourceId })) {
          throw new MobileCommerceError('Post unlock not found.', 404);
        }

        return unlockPostResourceBundle({
          adminSupabase,
          postId: resourceId,
          userId,
          // The buyer is waiting on this answer, so the pushes go out behind
          // it rather than in front.
          runAfterResponse: resolvedDependencies.runAfterResponse,
        });
      },
    }, resolvedDependencies),
    request,
  );
}
