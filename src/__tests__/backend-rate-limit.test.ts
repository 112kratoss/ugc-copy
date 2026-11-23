import { describe, expect, it, vi } from 'vitest';

import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
  refundBackendRateLimit,
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

  it('gives a count back in the window the check made it in', async () => {
    const client = createRpcClient({ data: true, error: null });

    await expect(refundBackendRateLimit(client, {
      scope: 'showcase-feed:for-you-read',
      key: 'user-1',
      windowSeconds: 600,
      resetAt: '2026-11-23T10:10:00.000Z',
    })).resolves.toBe(true);

    expect(client.rpc).toHaveBeenCalledWith('refund_backend_rate_limit', {
      p_scope: 'showcase-feed:for-you-read',
      p_subject_key: 'user-1',
      p_window_start: '2026-11-23T10:00:00.000Z',
    });
  });

  it('says when a window had nothing left to give, and throws a failed refund', async () => {
    const options = { scope: 'scope', key: 'key', windowSeconds: 600, resetAt: '2026-11-23T10:10:00.000Z' };
    await expect(refundBackendRateLimit(createRpcClient({ data: false, error: null }), options)).resolves.toBe(false);
    await expect(refundBackendRateLimit(createRpcClient({ data: null, error: new Error('down') }), options))
      .rejects.toThrow('down');
  });

  it('refuses a refund it cannot place before asking the database', async () => {
    const client = createRpcClient({ data: true, error: null });
    for (const options of [
      { scope: ' ', key: 'key', windowSeconds: 600, resetAt: '2026-11-23T10:10:00.000Z' },
      { scope: 'scope', key: '', windowSeconds: 600, resetAt: '2026-11-23T10:10:00.000Z' },
      { scope: 'scope', key: 'key', windowSeconds: 0, resetAt: '2026-11-23T10:10:00.000Z' },
      { scope: 'scope', key: 'key', windowSeconds: 600, resetAt: 'not a time' },
    ]) {
      await expect(refundBackendRateLimit(client, options)).rejects.toThrow();
    }
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
