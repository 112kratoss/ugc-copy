import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import {
  applyAdminPostModeration,
  applyAdminPostReportDecision,
  applyAdminSubjectReportDecision,
} from '@/lib/admin-moderation-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  ADMIN_POST_MODERATION_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * HTTP shell for admin moderation decisions. Auth is re-checked here rather
 * than trusted from middleware, and the reviewer id always comes from the
 * session — a caller cannot supply one in the request body.
 */

type DecisionBody = {
  reportId?: unknown;
  action?: unknown;
  note?: unknown;
};

type ModerationBody = {
  postId?: unknown;
  action?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

async function withAdminSession(
  request: Request,
  handler: (reviewerId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const auth = await authenticateAdminRequest(request);

  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.reason === 'unconfigured' ? 'Admin access is not configured.' : 'Unauthorized' },
      { status: auth.reason === 'unconfigured' ? 503 : 401, headers },
    );
  }

  try {
    return await handler(auth.identity.reviewerUserId);
  } catch (error) {
    logBackendRouteError(JSON.stringify({
      level: 'error',
      msg: 'admin_moderation_decision_failed',
      requestId: getApiRequestId(request),
      error: errorMessage(error),
    }));
    return NextResponse.json({ error: errorMessage(error) }, { status: 400, headers });
  }
}

export async function postAdminPostReportDecision(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);

  return withAdminSession(request, async (reviewerId) => {
    const body = (await request.json().catch(() => ({}))) as DecisionBody;
    const reportId = typeof body.reportId === 'string' ? body.reportId : '';
    const action = body.action === 'take_down' || body.action === 'dismiss' ? body.action : null;
    const note = typeof body.note === 'string' ? body.note : '';

    if (!reportId || !action) {
      return NextResponse.json({ error: 'reportId and action are required.' }, { status: 400, headers });
    }

    const resolution = await applyAdminPostReportDecision(createServiceClient(), {
      reportId,
      reviewerId,
      action,
      resolutionNote: note,
    });

    return NextResponse.json(resolution, { status: 200, headers });
  });
}

export async function postAdminSubjectReportDecision(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);

  return withAdminSession(request, async (reviewerId) => {
    const body = (await request.json().catch(() => ({}))) as DecisionBody;
    const reportId = typeof body.reportId === 'string' ? body.reportId : '';
    const action = body.action === 'resolve' || body.action === 'dismiss' ? body.action : null;
    const note = typeof body.note === 'string' ? body.note : '';

    if (!reportId || !action) {
      return NextResponse.json({ error: 'reportId and action are required.' }, { status: 400, headers });
    }

    const resolution = await applyAdminSubjectReportDecision(createServiceClient(), {
      reportId,
      reviewerId,
      action,
      resolutionNote: note,
    });

    return NextResponse.json(resolution, { status: 200, headers });
  });
}

/**
 * Proactive post moderation. Unlike the report endpoints this one takes a post
 * id directly, so it is rate limited: it is the only console path that can
 * irreversibly destroy a creator's media without a report to anchor it.
 */
export async function postAdminPostModeration(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);

  return withAdminSession(request, async (reviewerId) => {
    const client = createServiceClient();

    try {
      await enforceBackendRateLimit(client, {
        ...ADMIN_POST_MODERATION_RATE_LIMIT,
        key: reviewerId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }
      throw error;
    }

    const body = (await request.json().catch(() => ({}))) as ModerationBody;
    const postId = typeof body.postId === 'string' ? body.postId : '';
    const action = body.action === 'hide' || body.action === 'take_down' || body.action === 'restore'
      ? body.action
      : null;
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';

    if (!postId || !action) {
      return NextResponse.json({ error: 'postId and action are required.' }, { status: 400, headers });
    }
    if (!idempotencyKey) {
      return NextResponse.json({ error: 'idempotencyKey is required.' }, { status: 400, headers });
    }

    const result = await applyAdminPostModeration(client, {
      postId,
      reviewerId,
      action,
      reason,
      idempotencyKey,
    });

    if (result.status === 'invalid') {
      return NextResponse.json(
        { error: result.error ?? 'The moderation action was rejected.' },
        { status: 400, headers },
      );
    }
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Post not found.' }, { status: 404, headers });
    }
    // 409, not 400: the request was well formed and the operator is allowed to
    // make it — the post's own history is what makes it impossible.
    if (result.status === 'not_restorable') {
      return NextResponse.json(
        { error: result.error ?? 'This post cannot be restored.' },
        { status: 409, headers },
      );
    }

    return NextResponse.json(result, { status: 200, headers });
  });
}

export function createAdminPostReportRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminPostReportDecision(request);
    },
  };
}

export function createAdminSubjectReportRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminSubjectReportDecision(request);
    },
  };
}

export function createAdminPostModerationRouteHandlers() {
  return {
    POST(request: Request) {
      return postAdminPostModeration(request);
    },
  };
}
