import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
const deleteCalls: string[] = [];
const selectCalls: string[] = [];
const storageRemoveCalls: Array<{ bucket: string; paths: string[] }> = [];

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
  getStoredMediaLocation: () => null,
}));

function createUserSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
  };
}

function createQuery(result: { data: unknown; error: { message: string } | null }) {
  const query = {
    eq() {
      return query;
    },
    is() {
      return query;
    },
    not() {
      return query;
    },
    select() {
      return query;
    },
    maybeSingle: vi.fn(async () => result),
    then(resolve: (value: typeof result) => void) {
      return Promise.resolve(result).then(resolve);
    },
  };
  return query;
}

function createAdminSupabaseMock() {
  return {
    rpc: rateLimitRpcMock,
    from(table: string) {
      return {
        select() {
          selectCalls.push(table);
          if (table === 'generations') {
            return createQuery({
              data: {
                id: 'gen-1',
                user_id: 'user-1',
                output_url: null,
                showcase_asset_path: null,
              },
              error: null,
            });
          }
          return createQuery({
            data: [],
            error: null,
          });
        },
        update(values: Record<string, unknown>) {
          updateCalls.push({ table, values });
          return createQuery({
            data: { id: 'gen-1' },
            error: null,
          });
        },
        delete() {
          deleteCalls.push(table);
          return createQuery({
            data: null,
            error: null,
          });
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          async remove(paths: string[]) {
            storageRemoveCalls.push({ bucket, paths });
            return { data: null, error: null };
          },
        };
      },
    },
  };
}

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

function makeRequest(url: string, method: string, requestId: string) {
  return new Request(url, {
    method,
    headers: {
      Authorization: 'Bearer token',
      'x-request-id': requestId,
    },
  }) as NextRequest;
}

function routeContext() {
  return {
    params: Promise.resolve({ id: 'gen-1' }),
  };
}

function denyLifecycleLimit(retryAfterSeconds = 44) {
  rateLimitRpcMock.mockResolvedValue({
    data: {
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  });
}

describe('generation lifecycle route rate limits', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    updateCalls.length = 0;
    deleteCalls.length = 0;
    selectCalls.length = 0;
    storageRemoveCalls.length = 0;
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
    createServiceClientMock.mockReturnValue(createAdminSupabaseMock());
    denyLifecycleLimit();
  });

  it('returns 429 before archiving a generation when lifecycle mutation capacity is exhausted', async () => {
    const { POST } = await import('@/app/api/generations/[id]/archive/route');
    const response = await POST(
      makeRequest('http://localhost/api/generations/gen-1/archive', 'POST', 'generation-archive-rate-limit-1'),
      routeContext(),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('44');
    expectPrivateNoStoreTraceHeaders(response, 'generation-archive-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'generation-lifecycle:mutate',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([]);
  });

  it('returns 429 before restoring a generation when lifecycle mutation capacity is exhausted', async () => {
    const { POST } = await import('@/app/api/generations/[id]/restore/route');
    const response = await POST(
      makeRequest('http://localhost/api/generations/gen-1/restore', 'POST', 'generation-restore-rate-limit-1'),
      routeContext(),
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'generation-restore-rate-limit-1');
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'generation-lifecycle:mutate',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([]);
  });

  it('returns 429 before deleting a generation when lifecycle mutation capacity is exhausted', async () => {
    const { DELETE } = await import('@/app/api/generations/[id]/route');
    const response = await DELETE(
      makeRequest('http://localhost/api/generations/gen-1', 'DELETE', 'generation-delete-rate-limit-1'),
      routeContext(),
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'generation-delete-rate-limit-1');
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'generation-lifecycle:mutate',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(selectCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
    expect(storageRemoveCalls).toEqual([]);
  });
});
