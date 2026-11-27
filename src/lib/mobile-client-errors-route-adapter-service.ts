import 'server-only';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  BackendRateLimitError,
  MOBILE_CLIENT_ERRORS_DAILY_CAP,
  MOBILE_CLIENT_ERRORS_NETWORK_RATE_LIMIT,
  MOBILE_CLIENT_ERRORS_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { isGuestUser } from '@/lib/account-identity';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { parseMobileClientErrorReport, recordMobileClientError } from '@/lib/mobile-client-errors';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

/** A report is at most about 7 KB of text once truncated; room for JSON escaping. */
export const MAX_MOBILE_CLIENT_ERROR_BYTES = 16 * 1024;

type MobileClientErrorsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getRateLimitKey?: (headers: Headers) => string;
  getOptionalIdentity?: (request: Request) => Promise<ReportIdentity | null>;
  logError?: typeof logBackendRouteError;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  recordMobileClientError?: typeof recordMobileClientError;
};

type ReportIdentity = { userId: string; registered: boolean };

/**
 * The identity a report came from, when it came with a session: a registered account or a guest.
 * A session that cannot be verified is no identity here, never a 401: the app reads a 401 as its
 * session ending, and an error report must never sign anybody out.
 */
async function getOptionalIdentity(request: Request): Promise<ReportIdentity | null> {
  if (!request.headers.get('Authorization')) return null;
  try {
    const { data: { user }, error } = await getVerifiedAuthUserResult(createUserClient(request));
    if (error || !user?.id) return null;
    return { userId: user.id, registered: !isGuestUser(user) };
  } catch {
    return null;
  }
}

function resolveDependencies(dependencies: MobileClientErrorsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getRateLimitKey: dependencies?.getRateLimitKey ?? getClientNetworkKey,
    getOptionalIdentity: dependencies?.getOptionalIdentity ?? getOptionalIdentity,
    logError: dependencies?.logError ?? logBackendRouteError,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
    recordMobileClientError: dependencies?.recordMobileClientError ?? recordMobileClientError,
  };
}

async function handleMobileClientErrorPost(request: Request, dependencies: ReturnType<typeof resolveDependencies>) {
  const admin = dependencies.createServiceClient();
  // The network's budget first: before the body is read or a token looked up, so a bogus token
  // costs no auth round trip.
  try {
    await dependencies.enforceBackendRateLimit(admin, {
      ...MOBILE_CLIENT_ERRORS_NETWORK_RATE_LIMIT,
      key: dependencies.getRateLimitKey(request.headers),
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
    dependencies.logError('Client error report rate limit failed:', error);
    return Response.json({ error: 'Failed to check client error report limits.' }, { status: 500 });
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return Response.json({ error: 'Unsupported client error report content type.' }, { status: 415 });
  }

  let body;
  try {
    body = await dependencies.readBoundedJsonBody(request, MAX_MOBILE_CLIENT_ERROR_BYTES);
  } catch (error) {
    dependencies.logError('Client error report body read failed:', error);
    return Response.json({ error: 'Failed to read client error report.' }, { status: 500 });
  }
  if (!body.ok) {
    return Response.json(
      { error: body.reason === 'too_large' ? 'Client error report is too large.' : 'Invalid client error report.' },
      { status: body.reason === 'too_large' ? 413 : 400 },
    );
  }

  const report = parseMobileClientErrorReport(body.value);
  if (!report) return Response.json({ error: 'Invalid client error report.' }, { status: 400 });

  const identity = await dependencies.getOptionalIdentity(request);
  // A registered account has a budget of its own as well; a guest session, free to mint, does not.
  if (identity?.registered) {
    try {
      await dependencies.enforceBackendRateLimit(admin, { ...MOBILE_CLIENT_ERRORS_RATE_LIMIT, key: identity.userId });
    } catch (error) {
      if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
      dependencies.logError('Client error report rate limit failed:', error);
      return Response.json({ error: 'Failed to check client error report limits.' }, { status: 500 });
    }
  }
  const userId = identity?.userId ?? null;
  try {
    await dependencies.enforceBackendRateLimit(admin, { ...MOBILE_CLIENT_ERRORS_DAILY_CAP, key: 'all' });
  } catch (error) {
    // Past the day's cap, or unable to count it: dropped quietly, never stored.
    if (!(error instanceof BackendRateLimitError)) dependencies.logError('Client error report daily cap failed:', error);
    return new Response(null, { status: 204 });
  }

  try {
    await dependencies.recordMobileClientError(admin, report, userId);
  } catch (error) {
    dependencies.logError('Client error report insert failed:', error);
    return Response.json({ error: 'Failed to store client error report.' }, { status: 500 });
  }
  return new Response(null, { status: 204 });
}

/**
 * `POST /api/mobile/client-errors`: the mobile app's error reports (audit 2026-11-27). Public in
 * the route policy, so a guest's report and one sent while the session is what is failing both
 * arrive; limited per network first, per registered account too, and by a global daily cap that
 * drops quietly; body-capped, and validated and truncated again here.
 */
export async function postMobileClientErrorsRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileClientErrorsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMobileClientErrorPost(request, resolveDependencies(dependencies)),
    request,
  );
}
