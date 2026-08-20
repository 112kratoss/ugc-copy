import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  PROFILE_VALIDATE_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { validateProfileSubmission } from '@/lib/profile-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ProfileValidateRouteAdapterDependencies = {
  createServiceClient?: () => SupabaseClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof logBackendRouteError;
  validateProfileSubmission?: typeof validateProfileSubmission;
};

function resolveDependencies(dependencies: ProfileValidateRouteAdapterDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
    validateProfileSubmission:
      dependencies?.validateProfileSubmission ?? validateProfileSubmission,
  };
}

async function handleProfileValidatePOST(
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

    const adminSupabase = dependencies.createServiceClient();
    try {
      await dependencies.enforceBackendRateLimit(adminSupabase, {
        ...PROFILE_VALIDATE_RATE_LIMIT,
        key: user.id,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Profile validate rate limit check failed:', error);
      return NextResponse.json(
        { error: 'Failed to check profile validation limits.' },
        { status: 500 },
      );
    }

    const validation = await dependencies.validateProfileSubmission(
      adminSupabase,
      user.id,
      await request.json(),
    );

    if (!validation.ok) {
      return NextResponse.json(validation.body, { status: validation.status });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    dependencies.logError('Profile validate error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postProfileValidateRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ProfileValidateRouteAdapterDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleProfileValidatePOST(request, resolveDependencies(dependencies)),
    request,
  );
}
