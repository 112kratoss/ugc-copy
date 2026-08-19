import 'server-only';

import { NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import { setContactMessageHandled } from '@/lib/admin-contact-triage-service';
import {
  applyAdminGenerationModeration,
  type AdminGenerationModerationAction,
} from '@/lib/admin-generation-moderation-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  ADMIN_CONTENT_MODERATION_RATE_LIMIT,
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * HTTP shell for generation removal and contact-queue triage.
 *
 * Both take their reviewer from the session, never the body: a caller able to
 * name the operator could attribute a removal to someone else, and the audit
 * trail would be worse than useless.
 */

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

async function withAdminOperator(
  request: Request,
  logKey: string,
  handler: (reviewerId: string, client: ReturnType<typeof createServiceClient>) => Promise<NextResponse>,
): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);

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
      ...ADMIN_CONTENT_MODERATION_RATE_LIMIT,
      key: auth.identity.reviewerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }
    throw error;
  }

  try {
    return await handler(auth.identity.reviewerUserId, client);
  } catch (error) {
    logBackendRouteError(JSON.stringify({
      level: 'error',
      msg: logKey,
      requestId: getApiRequestId(request),
      error: errorMessage(error),
    }));
    return NextResponse.json(
      { error: 'Action failed. Confirm the admin migrations have been applied.' },
      { status: 500, headers },
    );
  }
}

export async function postAdminGenerationModeration(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);

  return withAdminOperator(request, 'admin_generation_moderation_failed', async (reviewerId, client) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const generationId = typeof body.generationId === 'string' ? body.generationId : '';
    const action: AdminGenerationModerationAction | null =
      body.action === 'remove' || body.action === 'restore' ? body.action : null;
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : undefined;

    if (!generationId || !action) {
      return NextResponse.json(
        { error: 'generationId and a valid action are required.' },
        { status: 400, headers },
      );
    }

    const result = await applyAdminGenerationModeration(client, {
      generationId, reviewerId, action, reason, idempotencyKey,
    });

    if (result.status === 'invalid') {
      return NextResponse.json({ error: result.error ?? 'Rejected.' }, { status: 400, headers });
    }
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Generation not found.' }, { status: 404, headers });
    }
    return NextResponse.json(result, { status: 200, headers });
  });
}

export async function postAdminContactTriage(request: Request): Promise<NextResponse> {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);

  return withAdminOperator(request, 'admin_contact_triage_failed', async (reviewerId, client) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    if (!messageId || typeof body.handled !== 'boolean') {
      return NextResponse.json(
        { error: 'messageId and a boolean handled flag are required.' },
        { status: 400, headers },
      );
    }

    const result = await setContactMessageHandled(client, {
      messageId,
      reviewerId,
      handled: body.handled,
      note: typeof body.note === 'string' ? body.note : null,
    });

    if (result.status === 'invalid') {
      return NextResponse.json({ error: result.error ?? 'Rejected.' }, { status: 400, headers });
    }
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'Message not found.' }, { status: 404, headers });
    }
    return NextResponse.json(result, { status: 200, headers });
  });
}

export function createAdminGenerationModerationRouteHandlers() {
  return { POST(request: Request) { return postAdminGenerationModeration(request); } };
}

export function createAdminContactTriageRouteHandlers() {
  return { POST(request: Request) { return postAdminContactTriage(request); } };
}
