import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/account-identity';
import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  UPLOAD_FINALIZE_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { finalizeUploadRequest } from '@/lib/upload-finalization';

export const UPLOAD_FINALIZE_BODY_MAX_BYTES = 1024;

type UploadFinalizeRouteDependencies = {
  createServiceClient?: () => SupabaseClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  finalizeUploadRequest?: typeof finalizeUploadRequest;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  requireIdentity?: typeof requireIdentity;
};

function resolveDependencies(dependencies?: UploadFinalizeRouteDependencies) {
  return {
    createServiceClient: dependencies?.createServiceClient
      ?? createServiceClient as unknown as () => SupabaseClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    finalizeUploadRequest: dependencies?.finalizeUploadRequest ?? finalizeUploadRequest,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
  };
}

export async function postUploadFinalizeRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: UploadFinalizeRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  const userClient = resolved.createUserClient(request);
  let serviceClient: SupabaseClient | null = null;
  const getServiceClient = () => {
    serviceClient ??= resolved.createServiceClient();
    return serviceClient;
  };
  const identity = await resolved.requireIdentity(userClient, getServiceClient);
  if (!identity.ok) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json(
        { error: identity.error, code: identity.code },
        { status: identity.status },
      ),
      request,
    );
  }

  try {
    await resolved.enforceBackendRateLimit(getServiceClient(), {
      ...UPLOAD_FINALIZE_RATE_LIMIT,
      key: identity.identity.userId,
    });
  } catch (error) {
    const response = error instanceof BackendRateLimitError
      ? createBackendRateLimitResponse(error)
      : NextResponse.json(
          { error: 'Failed to check upload finalization limits.' },
          { status: 500 },
        );
    return applyPrivateNoStoreApiResponseHeaders(response, request);
  }

  const parsed = await resolved.readBoundedJsonBody(request, UPLOAD_FINALIZE_BODY_MAX_BYTES);
  if (!parsed.ok && parsed.reason === 'too_large') {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json(
        { error: 'Upload finalization request is too large.', code: 'REQUEST_TOO_LARGE' },
        { status: 413 },
      ),
      request,
    );
  }

  const result = await resolved.finalizeUploadRequest(getServiceClient(), {
    body: parsed.ok ? parsed.value : null,
    userId: identity.identity.userId,
  });
  const response = result.ok
    ? NextResponse.json(result.descriptor)
    : NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return applyPrivateNoStoreApiResponseHeaders(response, request);
}
