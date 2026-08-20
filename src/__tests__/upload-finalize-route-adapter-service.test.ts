import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  UPLOAD_FINALIZE_BODY_MAX_BYTES,
  postUploadFinalizeRouteResponse,
} from '@/lib/upload-finalize-route-adapter-service';

const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';

function admittedIdentity() {
  return {
    ok: true as const,
    identity: {
      user: { id: 'user-1', is_anonymous: false } as never,
      userId: 'user-1',
      kind: 'registered' as const,
      isGuest: false,
    },
  };
}

describe('generic upload finalizer route', () => {
  it('rate-admits the active identity before bounded parsing and returns trusted metadata', async () => {
    const serviceClient = { kind: 'service' } as unknown as SupabaseClient;
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 120,
      remaining: 119,
      retryAfterSeconds: 0,
      resetAt: '2026-08-19T12:00:00.000Z',
    }));
    const readBoundedJsonBody = vi.fn(async () => ({
      ok: true as const,
      value: { uploadId: UPLOAD_ID },
    }));
    const finalizeUploadRequest = vi.fn(async () => ({
      ok: true as const,
      canonicalPath: 'uploads/user-1/reference.png',
      reservationId: UPLOAD_ID,
      descriptor: {
        bucket: 'uploads',
        path: 'user-1/reference.png',
        storagePath: 'uploads/user-1/reference.png',
        contentType: 'image/png',
        sizeBytes: 3,
      },
    }));
    const request = new Request('http://localhost/api/uploads/finalize', {
      method: 'POST',
      body: JSON.stringify({ uploadId: UPLOAD_ID }),
    });

    const response = await postUploadFinalizeRouteResponse({
      request,
      dependencies: {
        createServiceClient: () => serviceClient,
        createUserClient: () => ({}) as SupabaseClient,
        enforceBackendRateLimit,
        finalizeUploadRequest,
        readBoundedJsonBody,
        requireIdentity: vi.fn(async () => admittedIdentity()),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(serviceClient, {
      scope: 'upload:finalize',
      limit: 120,
      windowSeconds: 600,
      key: 'user-1',
    });
    expect(readBoundedJsonBody).toHaveBeenCalledWith(request, UPLOAD_FINALIZE_BODY_MAX_BYTES);
    expect(finalizeUploadRequest).toHaveBeenCalledWith(serviceClient, {
      body: { uploadId: UPLOAD_ID },
      userId: 'user-1',
    });
    await expect(response.json()).resolves.toMatchObject({
      storagePath: 'uploads/user-1/reference.png',
      sizeBytes: 3,
    });
  });

  it('rejects at the rate boundary before reading even malformed request bytes', async () => {
    const readBoundedJsonBody = vi.fn();
    const finalizeUploadRequest = vi.fn();
    const rateError = new BackendRateLimitError({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfterSeconds: 30,
      resetAt: '2026-08-19T12:00:00.000Z',
    });

    const response = await postUploadFinalizeRouteResponse({
      request: new Request('http://localhost/api/uploads/finalize', {
        method: 'POST',
        body: '{invalid',
      }),
      dependencies: {
        createServiceClient: () => ({}) as SupabaseClient,
        createUserClient: () => ({}) as SupabaseClient,
        enforceBackendRateLimit: vi.fn(async () => { throw rateError; }),
        finalizeUploadRequest,
        readBoundedJsonBody,
        requireIdentity: vi.fn(async () => admittedIdentity()),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(readBoundedJsonBody).not.toHaveBeenCalled();
    expect(finalizeUploadRequest).not.toHaveBeenCalled();
  });

  it('returns 413 and never finalizes when streaming JSON crosses its byte limit', async () => {
    const finalizeUploadRequest = vi.fn();
    const response = await postUploadFinalizeRouteResponse({
      request: new Request('http://localhost/api/uploads/finalize', {
        method: 'POST',
        body: JSON.stringify({ uploadId: UPLOAD_ID }),
      }),
      dependencies: {
        createServiceClient: () => ({}) as SupabaseClient,
        createUserClient: () => ({}) as SupabaseClient,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 120,
          remaining: 119,
          retryAfterSeconds: 0,
          resetAt: '2026-08-19T12:00:00.000Z',
        })),
        finalizeUploadRequest,
        readBoundedJsonBody: vi.fn(async () => ({ ok: false as const, reason: 'too_large' as const })),
        requireIdentity: vi.fn(async () => admittedIdentity()),
      },
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    expect(finalizeUploadRequest).not.toHaveBeenCalled();
  });
});
