import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import {
  applyAdminUserSanction,
  type AdminUserSanctionAction,
} from '@/lib/admin-user-sanction-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  ADMIN_USER_SANCTION_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * HTTP shell for account suspensions.
 *
 * The reviewer id comes from the session and never from the body — otherwise a
 * caller could attribute a suspension to someone else, and the audit trail
 * would name the wrong operator. The idempotency key does come from the client
 * so a double-submitted form collapses to one sanction.
 */

type SanctionBody = {
  userId?: unknown;
  action?: unknown;
  reason?: unknown;
  durationHours?: unknown;
  idempotencyKey?: unknown;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export async function postAdminUserSanction(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const requestId = getApiRequestId(request);

  const auth = await authenticateAdminRequest(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.reason === 'unconfigured' ? 'Admin access is not configured.' : 'Unauthorized' },
      { status: auth.reason === 'unconfigured' ? 503 : 401, headers },
    );
  }

  const client = createServiceClient();

  try {
    await enforceBackendRateLimit(client, {
      ...ADMIN_USER_SANCTION_RATE_LIMIT,
      key: auth.identity.reviewerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as SanctionBody;
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const action: AdminUserSanctionAction | null =
    body.action === 'suspend' || body.action === 'reinstate' ? body.action : null;
  const reason = typeof body.reason === 'string' ? body.reason : '';
  // `null` is meaningful here (indefinite), so it must survive the parse rather
  // than being coerced to 0 and read as "no duration given".
  const durationHours = body.durationHours === null || body.durationHours === undefined
    ? null
    : Number(body.durationHours);
  const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim()
    : undefined;

  if (!userId || !action) {
    return NextResponse.json(
      { error: 'userId and a valid action are required.' },
      { status: 400, headers },
    );
  }

  try {
    const result = await applyAdminUserSanction(client, {
      userId,
      reviewerId: auth.identity.reviewerUserId,
      action,
      reason,
      durationHours,
      idempotencyKey,
    });

    if (result.status === 'invalid') {
      return NextResponse.json(
        { error: result.error ?? 'Sanction was rejected.' },
        { status: 400, headers },
      );
    }
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'User not found.' }, { status: 404, headers });
    }

    return NextResponse.json(result, { status: 200, headers });
  } catch (error) {
    logBackendRouteError(JSON.stringify({
      level: 'error',
      msg: 'admin_user_sanction_failed',
      requestId,
      error: errorMessage(error),
    }));
    return NextResponse.json(
      { error: 'Sanction failed. Confirm the admin sanction migration has been applied.' },
      { status: 500, headers },
    );
  }
}

export function createAdminUserSanctionRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminUserSanction(request);
    },
  };
}
