import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  applyPrivateNoStoreApiResponseHeaders,
  createPrivateNoStoreApiResponseHeaders,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
} from '@/lib/backend-rate-limit';
import { MediaTemplateError } from '@/lib/media-template-types';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

export async function getTemplateApiAuth(request: Request, required = true) {
  const userClient = createUserClient(request);
  const { data: { user }, error } = await userClient.auth.getUser();
  if ((error || !user) && required) {
    throw new MediaTemplateError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  return {
    userClient,
    adminClient: createServiceClient(),
    userId: user?.id ?? null,
  };
}

export async function readTemplateApiBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new MediaTemplateError('Invalid JSON body.', 400, 'INVALID_JSON');
  }
}

export function templateApiResponse(request: Request, body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: createPrivateNoStoreApiResponseHeaders(request),
  });
}

export function templateApiErrorResponse(request: Request, error: unknown) {
  if (error instanceof BackendRateLimitError) {
    return applyPrivateNoStoreApiResponseHeaders(createBackendRateLimitResponse(error), request);
  }
  if (error instanceof MediaTemplateError) {
    return templateApiResponse(request, {
      error: error.message,
      code: error.code,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    }, error.status);
  }
  logBackendError('media_template_api_error', { error: error });
  return templateApiResponse(request, { error: 'Internal server error.', code: 'INTERNAL_ERROR' }, 500);
}
