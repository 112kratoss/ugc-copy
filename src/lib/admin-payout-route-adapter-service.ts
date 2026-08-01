import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import { resolveCreatorPayoutRequest } from '@/lib/creator-payout-ops';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * HTTP shell for settling creator payouts. Like every other admin decision,
 * auth is re-checked here rather than trusted from middleware, and the reviewer
 * id comes from the session — never from the request body.
 */

type PayoutDecisionBody = {
  requestId?: unknown;
  action?: unknown;
  note?: unknown;
  externalReference?: unknown;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function postAdminPayoutDecision(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const auth = await authenticateAdminRequest(request);

  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.reason === 'unconfigured' ? 'Admin access is not configured.' : 'Unauthorized' },
      { status: auth.reason === 'unconfigured' ? 503 : 401, headers },
    );
  }

  let body: PayoutDecisionBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers });
  }

  if (typeof body.requestId !== 'string' || !body.requestId.trim()) {
    return NextResponse.json({ error: 'A payout request id is required.' }, { status: 400, headers });
  }

  if (body.action !== 'mark_paid' && body.action !== 'reject') {
    return NextResponse.json({ error: 'Unsupported payout action.' }, { status: 400, headers });
  }

  try {
    const result = await resolveCreatorPayoutRequest({
      adminSupabase: createServiceClient(),
      requestId: body.requestId.trim(),
      reviewerUserId: auth.identity.reviewerUserId,
      action: body.action,
      resolutionNote: optionalString(body.note),
      externalReference: optionalString(body.externalReference),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: 400, headers });
    }

    return NextResponse.json({ success: true, ...result }, { headers });
  } catch (error) {
    logBackendRouteError(JSON.stringify({
      level: 'error',
      msg: 'admin_payout_decision_failed',
      requestId: getApiRequestId(request),
      error: errorMessage(error),
    }));
    return NextResponse.json({ error: errorMessage(error) }, { status: 400, headers });
  }
}

export function createAdminPayoutRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminPayoutDecision(request);
    },
  };
}
