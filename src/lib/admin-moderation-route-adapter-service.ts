import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import {
  applyAdminPostReportDecision,
  applyAdminSubjectReportDecision,
} from '@/lib/admin-moderation-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
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

    if (!reportId || !action) {
      return NextResponse.json({ error: 'reportId and action are required.' }, { status: 400, headers });
    }

    const resolution = await applyAdminSubjectReportDecision(createServiceClient(), {
      reportId,
      reviewerId,
      action,
    });

    return NextResponse.json(resolution, { status: 200, headers });
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
