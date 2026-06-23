import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const updateCalls: Array<{ table: string; values: Record<string, unknown> }> = [];

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
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
        update(values: Record<string, unknown>) {
          updateCalls.push({ table, values });
          return createQuery({
            data: { id: 'post-1', generation_id: 'gen-1' },
            error: null,
          });
        },
      };
    },
  };
}

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

function makeRequest(url: string, requestId: string) {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token',
      'x-request-id': requestId,
    },
  }) as NextRequest;
}

function routeContext() {
  return {
    params: Promise.resolve({ postId: 'post-1' }),
  };
}

function denyPostMutationLimit(retryAfterSeconds = 44) {
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

describe('post lifecycle route rate limits', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    updateCalls.length = 0;
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
    createServiceClientMock.mockReturnValue(createAdminSupabaseMock());
    denyPostMutationLimit();
  });

  it('returns 429 before archiving a post when mutation capacity is exhausted', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/archive/route');
    const response = await POST(
      makeRequest('http://localhost/api/posts/post-1/archive', 'post-archive-rate-limit-1'),
      routeContext(),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('44');
    expectPrivateNoStoreTraceHeaders(response, 'post-archive-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post:mutate',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([]);
  });

  it('returns 429 before restoring a post when mutation capacity is exhausted', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/restore/route');
    const response = await POST(
      makeRequest('http://localhost/api/posts/post-1/restore', 'post-restore-rate-limit-1'),
      routeContext(),
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'post-restore-rate-limit-1');
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post:mutate',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(updateCalls).toEqual([]);
  });
});
