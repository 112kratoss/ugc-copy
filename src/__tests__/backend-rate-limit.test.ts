import { describe, expect, it, vi } from 'vitest';

import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

function createRpcClient(result: { data: unknown; error: Error | null }) {
  return {
    rpc: vi.fn(async () => result),
  };
}

describe('backend rate limiting', () => {
  it('allows requests while capacity remains', async () => {
    const client = createRpcClient({
      data: {
        allowed: true,
        limit: 30,
        remaining: 29,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const state = await enforceBackendRateLimit(client, {
      scope: 'media-generation:start',
      key: 'user-1',
      limit: 30,
      windowSeconds: 600,
    });

    expect(state).toMatchObject({ allowed: true, remaining: 29 });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'media-generation:start',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
  });

  it('throws a typed 429 error when the database limit is exceeded', async () => {
    const client = createRpcClient({
      data: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 42,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    await expect(enforceBackendRateLimit(client, {
      scope: 'media-generation:start',
      key: 'user-1',
      limit: 30,
      windowSeconds: 600,
    })).rejects.toMatchObject({
      name: 'BackendRateLimitError',
      status: 429,
      retryAfterSeconds: 42,
    });
  });

  it('builds a retryable JSON response for route handlers', async () => {
    const response = createBackendRateLimitResponse(new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-21T06:30:00.000Z',
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
    });
  });
});
