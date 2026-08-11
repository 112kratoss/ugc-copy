import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  getProfileForRoute,
  updateProfileForRoute,
  type ProfileRouteResult,
} from '@/lib/profile-route-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ProfileRouteAdapterDependencies = {
  createUserClient?: typeof createUserClient;
  createServiceClient?: () => SupabaseClient;
  getProfileForRoute?: typeof getProfileForRoute;
  updateProfileForRoute?: typeof updateProfileForRoute;
};

export type ProfileRouteAdapterResult = {
  status: number;
  body: unknown;
  headers: Headers;
};

function resolveDependencies(dependencies: ProfileRouteAdapterDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    getProfileForRoute: dependencies?.getProfileForRoute ?? getProfileForRoute,
    updateProfileForRoute: dependencies?.updateProfileForRoute ?? updateProfileForRoute,
  };
}

function createProfileHeaders(request: Request, result?: Extract<ProfileRouteResult, { ok: false }>) {
  const headers = new Headers(createPrivateNoStoreApiResponseHeaders(request));
  if (!result) return headers;

  if (result.retryAfterSeconds !== undefined) {
    headers.set('Retry-After', String(result.retryAfterSeconds));
  }
  if (result.limit !== undefined) {
    headers.set('X-RateLimit-Limit', String(result.limit));
  }
  if (result.remaining !== undefined) {
    headers.set('X-RateLimit-Remaining', String(result.remaining));
  }
  if (result.resetAt) {
    headers.set('X-RateLimit-Reset', result.resetAt);
  }

  return headers;
}

function createProfileRouteResult(
  request: Request,
  body: unknown,
  status = 200,
): ProfileRouteAdapterResult {
  return {
    status,
    body,
    headers: createProfileHeaders(request),
  };
}

function createProfileRouteErrorResult(
  request: Request,
  result: Extract<ProfileRouteResult, { ok: false }>,
): ProfileRouteAdapterResult {
  return {
    status: result.status,
    headers: createProfileHeaders(request, result),
    body: {
      error: result.error,
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
      ...(result.code ? { code: result.code } : {}),
      ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      ...(result.limit !== undefined ? { limit: result.limit } : {}),
      ...(result.resetAt ? { resetAt: result.resetAt } : {}),
    },
  };
}

async function authenticateProfileRequest(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return null;
  }

  return user;
}

export async function getProfileRouteResult({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: ProfileRouteAdapterDependencies;
}): Promise<ProfileRouteAdapterResult> {
  const resolvedDependencies = resolveDependencies(dependencies);

  try {
    const user = await authenticateProfileRequest(request, resolvedDependencies);
    if (!user) {
      return createProfileRouteResult(request, { error: 'Unauthorized' }, 401);
    }

    const result = await resolvedDependencies.getProfileForRoute({
      user,
      client: resolvedDependencies.createServiceClient,
    });

    if (!result.ok) {
      return createProfileRouteErrorResult(request, result);
    }

    return createProfileRouteResult(request, result.response);
  } catch (error) {
    logBackendError('profile_get_error', { error: error });
    return createProfileRouteResult(request, { error: 'Internal server error' }, 500);
  }
}

export async function patchProfileRouteResult({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: ProfileRouteAdapterDependencies;
}): Promise<ProfileRouteAdapterResult> {
  const resolvedDependencies = resolveDependencies(dependencies);

  try {
    const user = await authenticateProfileRequest(request, resolvedDependencies);
    if (!user) {
      return createProfileRouteResult(request, { error: 'Unauthorized' }, 401);
    }

    // Guests hold a valid JWT but have no public presence: they cannot post,
    // comment, follow or sell, so a username buys them nothing they can use.
    // It does buy two things worth denying. A username is unique and finite, so
    // unlimited anonymous sessions could squat every good handle; and setting
    // one used to be enough to pass the welcome-credit eligibility check, which
    // reads "identity claimed" as a proxy for "registered". The database refuses
    // that claim outright now (20260811120000) — this is the outer of the two
    // gates, and the one that gives an honest error instead of a silent no-op.
    if (user.is_anonymous === true) {
      return createProfileRouteResult(
        request,
        { error: 'Create an account to set up your creator profile.' },
        403,
      );
    }

    const result = await resolvedDependencies.updateProfileForRoute({
      userId: user.id,
      body: await request.json(),
      client: resolvedDependencies.createServiceClient,
    });

    if (!result.ok) {
      return createProfileRouteErrorResult(request, result);
    }

    return createProfileRouteResult(request, result.response);
  } catch (error) {
    logBackendError('profile_patch_error', { error: error });
    return createProfileRouteResult(request, { error: 'Internal server error' }, 500);
  }
}

function profileRouteResponse(result: ProfileRouteAdapterResult) {
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export function createProfileRouteHandlers({
  dependencies,
}: {
  dependencies?: ProfileRouteAdapterDependencies;
} = {}) {
  return {
    async GET(request: Request) {
      return profileRouteResponse(await getProfileRouteResult({ request, dependencies }));
    },
    async PATCH(request: Request) {
      return profileRouteResponse(await patchProfileRouteResult({ request, dependencies }));
    },
  };
}
