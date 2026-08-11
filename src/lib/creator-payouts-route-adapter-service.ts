import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  POST_MUTATION_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  getCreatorPayoutState,
  isCreatorPayoutMethod,
  requestCreatorPayout,
} from '@/lib/creator-payouts';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type CreatorPayoutsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  getCreatorPayoutState?: typeof getCreatorPayoutState;
  requestCreatorPayout?: typeof requestCreatorPayout;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: CreatorPayoutsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getCreatorPayoutState: dependencies?.getCreatorPayoutState ?? getCreatorPayoutState,
    requestCreatorPayout: dependencies?.requestCreatorPayout ?? requestCreatorPayout,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

async function authenticate(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const { data: { user }, error } = await supabase.auth.getUser();
  // Guests hold a valid JWT but are not registered. Before anonymous
  // sessions existed these two were the same thing, so this check read
  // `!user` alone; it now has to say which it means. Registered-only per
  // route-identity-policy.ts.
  return error || !user || isGuestUser(user) ? null : user;
}

async function handleGET(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  const user = await authenticate(request, dependencies);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const state = await dependencies.getCreatorPayoutState({
      adminSupabase: dependencies.createServiceClient(),
      userId: user.id,
    });

    return NextResponse.json({ success: true, ...state });
  } catch (error) {
    dependencies.logError('Failed to load creator payout state:', error);
    return NextResponse.json({ error: 'Failed to load your payout balance.' }, { status: 500 });
  }
}

async function handlePOST(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  const user = await authenticate(request, dependencies);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminSupabase = dependencies.createServiceClient();

  try {
    await dependencies.enforceBackendRateLimit(adminSupabase, {
      ...POST_MUTATION_RATE_LIMIT,
      key: user.id,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    dependencies.logError('Failed to enforce payout rate limit:', error);
    return NextResponse.json({ error: 'Failed to request a payout.' }, { status: 500 });
  }

  let body: { payoutMethod?: unknown; payoutDetails?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!isCreatorPayoutMethod(body.payoutMethod)) {
    return NextResponse.json({ error: 'Choose how you want to be paid.' }, { status: 400 });
  }

  if (typeof body.payoutDetails !== 'string' || body.payoutDetails.trim().length < 3) {
    return NextResponse.json(
      { error: 'Add the account details we should send the payout to.' },
      { status: 400 },
    );
  }

  try {
    const result = await dependencies.requestCreatorPayout({
      adminSupabase,
      // Always the caller. A payout can never be requested on someone's behalf.
      userId: user.id,
      payoutMethod: body.payoutMethod,
      payoutDetails: body.payoutDetails,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      requestId: result.requestId,
      amountTokenSubunits: result.amountTokenSubunits,
    });
  } catch (error) {
    dependencies.logError('Failed to request creator payout:', error);
    return NextResponse.json({ error: 'Failed to request a payout.' }, { status: 500 });
  }
}

export function createCreatorPayoutsRouteHandlers({
  dependencies,
}: {
  dependencies?: CreatorPayoutsRouteDependencies;
} = {}) {
  const resolved = resolveDependencies(dependencies);

  return {
    async GET(request: Request) {
      return applyPrivateNoStoreApiResponseHeaders(await handleGET(request, resolved), request);
    },
    async POST(request: Request) {
      return applyPrivateNoStoreApiResponseHeaders(await handlePOST(request, resolved), request);
    },
  };
}
