import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SAVER_NOTICE_RECORD_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readSaverNoticeSeen, recordSaverNoticeSeen } from '@/lib/profile-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

/**
 * Whether an account has been told "Creators can see who saved their posts."
 * (`profiles.saver_notice_seen_at`). The web and the app read it before a
 * first save, so a person told on one device is not told again on another,
 * and record it once the notice has been read. Save alerts name a saver only
 * once it is recorded.
 */
type SaverNoticeRouteDependencies = {
  createServiceClient?: () => SupabaseClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof logBackendRouteError;
  readSaverNoticeSeen?: typeof readSaverNoticeSeen;
  recordSaverNoticeSeen?: typeof recordSaverNoticeSeen;
};

export type SaverNoticeResponseBody = { seen: boolean };

function resolveDependencies(dependencies: SaverNoticeRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
    readSaverNoticeSeen: dependencies?.readSaverNoticeSeen ?? readSaverNoticeSeen,
    recordSaverNoticeSeen: dependencies?.recordSaverNoticeSeen ?? recordSaverNoticeSeen,
  };
}

/** A registered account: a guest saves nothing, so it is told nothing. */
async function getRegisteredUserId(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  const {
    data: { user },
    error,
  } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));
  return error || !user || isGuestUser(user) ? null : user.id;
}

async function handleGET(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  try {
    const userId = await getRegisteredUserId(request, dependencies);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const seen = await dependencies.readSaverNoticeSeen(dependencies.createServiceClient(), userId);
    return NextResponse.json({ seen } satisfies SaverNoticeResponseBody);
  } catch (error) {
    dependencies.logError('Saver notice read error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handlePOST(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  try {
    const userId = await getRegisteredUserId(request, dependencies);
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const serviceClient = dependencies.createServiceClient();
    try {
      await dependencies.enforceBackendRateLimit(serviceClient, { ...SAVER_NOTICE_RECORD_RATE_LIMIT, key: userId });
    } catch (error) {
      if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
      throw error;
    }

    await dependencies.recordSaverNoticeSeen(serviceClient, userId);
    return NextResponse.json({ seen: true } satisfies SaverNoticeResponseBody);
  } catch (error) {
    dependencies.logError('Saver notice record error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function getSaverNoticeRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: SaverNoticeRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(await handleGET(request, resolveDependencies(dependencies)), request);
}

export async function postSaverNoticeRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: SaverNoticeRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(await handlePOST(request, resolveDependencies(dependencies)), request);
}
