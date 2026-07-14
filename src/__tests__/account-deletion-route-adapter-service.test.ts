import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';

function request(body: unknown, authorization = 'Bearer token') {
  return new Request('https://magicbooklet.test/api/account', {
    method: 'DELETE',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('account deletion route', () => {
  it('requires an authenticated user', async () => {
    const deleteUser = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('invalid') })) },
        })) as never,
        createServiceClient: (() => ({ auth: { admin: { deleteUser } } })) as never,
      },
    });

    expect(response.status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('requires an explicit permanent deletion confirmation', async () => {
    const deleteUser = vi.fn();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'delete' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
        })) as never,
        createServiceClient: (() => ({ auth: { admin: { deleteUser } } })) as never,
      },
    });

    expect(response.status).toBe(400);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('removes user-prefixed storage before deleting the auth account', async () => {
    const calls: string[] = [];
    const deleteUser = vi.fn(async (userId: string) => {
      calls.push(`delete:${userId}`);
      return { data: null, error: null };
    });
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
        })) as never,
        createServiceClient: (() => ({
          auth: { admin: { deleteUser } },
          storage: {
            from: (bucket: string) => ({
              list: vi.fn(async (prefix: string) => {
                calls.push(`list:${bucket}:${prefix}`);
                return { data: [], error: null };
              }),
              remove: vi.fn(async () => ({ data: [], error: null })),
            }),
          },
        })) as never,
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 3,
          remaining: 2,
          retryAfterSeconds: 0,
          resetAt: new Date().toISOString(),
        })),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, deleted: true });
    expect(calls.at(-1)).toBe('delete:user-1');
    expect(deleteUser).toHaveBeenCalledWith('user-1');
  });

  it('rate limits repeated permanent deletion attempts before changing account data', async () => {
    const deleteUser = vi.fn();
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    const response = await deleteAccountRouteResponse({
      request: request({ confirmation: 'DELETE' }),
      dependencies: {
        createUserClient: (() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
        })) as never,
        createServiceClient: (() => ({ auth: { admin: { deleteUser } } })) as never,
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 3,
            remaining: 0,
            retryAfterSeconds: 60,
            resetAt,
          });
        }),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
