import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import { applyReferralReviewAction, type ReferralReviewAction } from '@/lib/admin-referrals-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * HTTP shell for an operator's referral decisions. As for every other admin
 * decision, auth is re-checked here rather than trusted from middleware, and
 * the reviewer id comes from the session, never from the request body.
 */

type ReferralReviewBody = {
  action?: unknown;
  attributionId?: unknown;
  referralCodeId?: unknown;
  reason?: unknown;
};

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ACTIONS: readonly ReferralReviewAction[] = ['block', 'unblock', 'disable_link', 'enable_link'];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

function isReviewAction(value: unknown): value is ReferralReviewAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export async function postAdminReferralReview(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const auth = await authenticateAdminRequest(request);

  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.reason === 'unconfigured' ? 'Admin access is not configured.' : 'Unauthorized' },
      { status: auth.reason === 'unconfigured' ? 503 : 401, headers },
    );
  }

  let body: ReferralReviewBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers });
  }

  if (!isReviewAction(body.action)) {
    return NextResponse.json({ error: 'Unsupported referral action.' }, { status: 400, headers });
  }

  // A referral decision names a referral, a link decision names a link: an id
  // of the other kind would be read as the wrong subject.
  const onReferral = body.action === 'block' || body.action === 'unblock';
  const subjectId = onReferral ? body.attributionId : body.referralCodeId;
  if (typeof subjectId !== 'string' || !UUID_PATTERN.test(subjectId)) {
    return NextResponse.json(
      { error: onReferral ? 'A referral id is required.' : 'An invite link id is required.' },
      { status: 400, headers },
    );
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 1000) {
    return NextResponse.json(
      { error: 'Give a reason of 3 to 1000 characters.' },
      { status: 400, headers },
    );
  }

  try {
    const result = await applyReferralReviewAction(createServiceClient(), {
      action: body.action,
      subjectId,
      reason,
      reviewerUserId: auth.identity.reviewerUserId,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.code === 'not_found' ? 404 : 400, headers },
      );
    }

    return NextResponse.json({ success: true, status: result.status }, { headers });
  } catch (error) {
    logBackendRouteError(JSON.stringify({
      level: 'error',
      msg: 'admin_referral_review_failed',
      requestId: getApiRequestId(request),
      error: errorMessage(error),
    }));
    return NextResponse.json({ error: 'The decision could not be saved.' }, { status: 500, headers });
  }
}

export function createAdminReferralReviewRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminReferralReview(request);
    },
  };
}
