import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  ACCOUNT_DELETION_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  executeInitialAccountDeletion,
  markAccountDeletionStage,
} from '@/lib/account-deletion-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

const RECENT_AUTH_MAX_AGE_MS = 15 * 60 * 1000;
const RECENT_AUTH_FUTURE_SKEW_MS = 60 * 1000;

type AccountDeletionDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  invalidateShowcaseFeedCache?: typeof invalidateShowcaseFeedCache;
  logError?: typeof logBackendRouteError;
  now?: () => Date;
};

function hasRecentAuthentication(lastSignInAt: string | undefined, now: Date) {
  if (!lastSignInAt) return false;
  const signedInAtMs = Date.parse(lastSignInAt);
  if (!Number.isFinite(signedInAtMs)) return false;
  const ageMs = now.getTime() - signedInAtMs;
  return ageMs >= -RECENT_AUTH_FUTURE_SKEW_MS && ageMs <= RECENT_AUTH_MAX_AGE_MS;
}

async function parseConfirmation(request: Request) {
  try {
    const body = await request.json() as { confirmation?: unknown };
    return body.confirmation === 'DELETE';
  } catch {
    return false;
  }
}

function getBearerAccessToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return undefined;
  const token = authorization.slice(7).trim();
  return token || undefined;
}

export async function deleteAccountRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: AccountDeletionDependencies;
  request: Request;
}) {
  const resolved = {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    invalidateShowcaseFeedCache: dependencies?.invalidateShowcaseFeedCache ?? invalidateShowcaseFeedCache,
    logError: dependencies?.logError ?? logBackendRouteError,
    now: dependencies?.now ?? (() => new Date()),
  };
  const userClient = resolved.createUserClient(request);
  const { data: { user }, error: authError } = await userClient.auth.getUser();

  // Registered-only per route-identity-policy.ts. A guest holds a valid
    // JWT, so `!user` alone stopped meaning "not registered" the moment
    // anonymous sessions existed.
    if (authError || !user || isGuestUser(user)) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      request,
    );
  }

  if (!await parseConfirmation(request)) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Type DELETE to confirm permanent account deletion.' }, { status: 400 }),
      request,
    );
  }

  if (!hasRecentAuthentication(user.last_sign_in_at, resolved.now())) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({
        error: 'Please sign in again before permanently deleting your account.',
        code: 'RECENT_AUTH_REQUIRED',
        reauthenticate: true,
      }, { status: 403 }),
      request,
    );
  }

  const admin = resolved.createServiceClient();
  try {
    await resolved.enforceBackendRateLimit(admin, {
      ...ACCOUNT_DELETION_RATE_LIMIT,
      key: user.id,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return applyPrivateNoStoreApiResponseHeaders(
        createBackendRateLimitResponse(error),
        request,
      );
    }

    resolved.logError('Account deletion rate limit check failed:', error);
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Account deletion could not be completed. Please try again.' }, { status: 500 }),
      request,
    );
  }

  try {
    const deletion = await executeInitialAccountDeletion({
      accessToken: getBearerAccessToken(request),
      admin,
      userId: user.id,
      onNonFatalError: resolved.logError,
    });

    resolved.invalidateShowcaseFeedCache();

    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({
        success: true,
        deleted: true,
        cleanupPending: deletion.cleanupPending,
        ...(deletion.alreadyCompleted ? { alreadyDeleted: true } : {}),
      }),
      request,
    );
  } catch (error) {
    try {
      await markAccountDeletionStage(admin, user.id, 'failed', error);
    } catch (stageError) {
      resolved.logError('Account deletion failure stage could not be persisted:', stageError);
    }
    resolved.logError('Account deletion failed:', error);
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Account deletion could not be completed. Please try again.' }, { status: 500 }),
      request,
    );
  }
}
