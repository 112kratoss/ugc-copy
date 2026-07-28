import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import {
  applyAdminCreditAdjustment,
  type AdminCreditAdjustmentIntent,
} from '@/lib/admin-credit-adjustment-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  ADMIN_CREDIT_ADJUSTMENT_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * HTTP shell for operator credit adjustments.
 *
 * The reviewer id comes from the session, never from the body. The idempotency
 * key does come from the client so a double-submitted form collapses to one
 * adjustment; the database enforces uniqueness on it.
 */

const INTENTS: AdminCreditAdjustmentIntent[] = ['goodwill', 'refund', 'clawback'];

type AdjustmentBody = {
  userId?: unknown;
  intent?: unknown;
  amount?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export async function postAdminCreditAdjustment(request: Request): Promise<NextResponse> {
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
      ...ADMIN_CREDIT_ADJUSTMENT_RATE_LIMIT,
      key: auth.identity.reviewerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    throw error;
  }

  const body = (await request.json().catch(() => ({}))) as AdjustmentBody;
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const intent = INTENTS.includes(body.intent as AdminCreditAdjustmentIntent)
    ? (body.intent as AdminCreditAdjustmentIntent)
    : null;
  const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim()
    : undefined;

  if (!userId || !intent) {
    return NextResponse.json(
      { error: 'userId and a valid intent are required.' },
      { status: 400, headers },
    );
  }

  try {
    const result = await applyAdminCreditAdjustment(client, {
      userId,
      intent,
      amount,
      reason,
      reviewerId: auth.identity.reviewerUserId,
      idempotencyKey,
    });

    if (result.status === 'invalid') {
      return NextResponse.json(
        { error: result.error ?? 'Adjustment was rejected.' },
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
      msg: 'admin_credit_adjustment_failed',
      requestId,
      error: errorMessage(error),
    }));
    return NextResponse.json(
      { error: 'Credit adjustment failed. Confirm the admin migration has been applied.' },
      { status: 500, headers },
    );
  }
}

export function createAdminCreditRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminCreditAdjustment(request);
    },
  };
}
