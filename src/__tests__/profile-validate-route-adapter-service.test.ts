import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackendRateLimitError,
  PROFILE_VALIDATE_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { postProfileValidateRouteResponse } from '@/lib/profile-validate-route-adapter-service';

describe('profile validate route adapter service', () => {
  const createUserClient = vi.fn();
  const createServiceClient = vi.fn();
  const enforceBackendRateLimit = vi.fn();
  const validateProfileSubmission = vi.fn();
  const logError = vi.fn();
  const adminSupabase = { service: 'supabase-admin' };
  const user = {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'creator@example.test',
  };

  beforeEach(() => {
    createUserClient.mockReset();
    createUserClient.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user },
          error: null,
        })),
      },
    });
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(adminSupabase);
    enforceBackendRateLimit.mockReset();
    enforceBackendRateLimit.mockResolvedValue({
      allowed: true,
      limit: PROFILE_VALIDATE_RATE_LIMIT.limit,
      remaining: PROFILE_VALIDATE_RATE_LIMIT.limit - 1,
      retryAfterSeconds: 0,
      resetAt: '2026-06-23T00:00:00.000Z',
    });
    validateProfileSubmission.mockReset();
    validateProfileSubmission.mockResolvedValue({
      ok: true,
      payload: { data: {}, fieldErrors: {} },
      existingUsername: null,
    });
    logError.mockReset();
  });

  it('rejects unauthenticated profile validation before privileged work or body parsing', async () => {
    const json = vi.fn(async () => ({ username: 'blocked-name' }));
    createUserClient.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const response = await postProfileValidateRouteResponse({
      request: {
        headers: new Headers({ 'x-request-id': 'profile-validate-auth-1' }),
        json,
      } as unknown as Request,
      dependencies: {
        createUserClient,
        createServiceClient,
        enforceBackendRateLimit,
        validateProfileSubmission,
        logError,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('profile-validate-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(json).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(validateProfileSubmission).not.toHaveBeenCalled();
  });

  it('rate limits profile validation before parsing JSON or checking username uniqueness', async () => {
    const json = vi.fn(async () => ({ username: 'taken-name' }));
    enforceBackendRateLimit.mockRejectedValueOnce(new BackendRateLimitError({
      allowed: false,
      limit: PROFILE_VALIDATE_RATE_LIMIT.limit,
      remaining: 0,
      retryAfterSeconds: 20,
      resetAt: '2026-06-23T01:20:00.000Z',
    }));

    const response = await postProfileValidateRouteResponse({
      request: {
        headers: new Headers({ 'x-request-id': 'profile-validate-rate-limit-1' }),
        json,
      } as unknown as Request,
      dependencies: {
        createUserClient,
        createServiceClient,
        enforceBackendRateLimit,
        validateProfileSubmission,
        logError,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('20');
    expect(response.headers.get('X-RateLimit-Limit')).toBe(String(PROFILE_VALIDATE_RATE_LIMIT.limit));
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 20,
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, {
      ...PROFILE_VALIDATE_RATE_LIMIT,
      key: user.id,
    });
    expect(json).not.toHaveBeenCalled();
    expect(validateProfileSubmission).not.toHaveBeenCalled();
  });

  it('delegates profile validation with parsed payload after auth and throttling', async () => {
    const payload = {
      username: 'Creator-Name',
      displayName: 'Creator Name',
    };

    const response = await postProfileValidateRouteResponse({
      request: new Request('http://localhost/api/profile/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-validate-success-1',
        },
        body: JSON.stringify(payload),
      }),
      dependencies: {
        createUserClient,
        createServiceClient,
        enforceBackendRateLimit,
        validateProfileSubmission,
        logError,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('profile-validate-success-1');
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, {
      ...PROFILE_VALIDATE_RATE_LIMIT,
      key: user.id,
    });
    expect(validateProfileSubmission).toHaveBeenCalledWith(adminSupabase, user.id, payload);
  });

  it('maps validation failures without hiding field errors', async () => {
    validateProfileSubmission.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: {
        error: 'That username is already taken.',
        fieldErrors: {
          username: 'That username is already taken.',
        },
      },
    });

    const response = await postProfileValidateRouteResponse({
      request: new Request('http://localhost/api/profile/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'taken-name' }),
      }),
      dependencies: {
        createUserClient,
        createServiceClient,
        enforceBackendRateLimit,
        validateProfileSubmission,
        logError,
      },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'That username is already taken.',
      fieldErrors: {
        username: 'That username is already taken.',
      },
    });
  });
});
