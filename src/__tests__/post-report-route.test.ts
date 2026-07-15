import { beforeEach, describe, expect, it, vi } from 'vitest';

const showcaseCacheMocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => ({
  invalidateShowcaseFeedCache: showcaseCacheMocks.invalidate,
}));

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 10,
    remaining: 9,
    retryAfterSeconds: 0,
    resetAt: '2026-06-21T06:30:00.000Z',
  },
  error: null,
}));
const insertedReports: unknown[] = [];

let postRows: Array<{ id: string; archived_at: string | null }> = [];
let bundleRows: Array<{ id: string; post_id: string }> = [];

function createServiceClientMock() {
  return {
    rpc: rpcMock,
    from(table: string) {
      if (table === 'posts') {
        const filters: Record<string, unknown> = {};

        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          is(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          async maybeSingle() {
            return {
              data: postRows.find((row) =>
                Object.entries(filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value)
              ) ?? null,
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_resource_bundles') {
        const filters: Record<string, unknown> = {};

        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          async maybeSingle() {
            return {
              data: bundleRows.find((row) =>
                Object.entries(filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value)
              ) ?? null,
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_reports') {
        return {
          async insert(payload: unknown) {
            insertedReports.push(payload);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

const createServiceClientFactory = vi.fn(() => createServiceClientMock());

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/posts/[postId]/report route', () => {
  beforeEach(() => {
    vi.resetModules();
    insertedReports.length = 0;
    postRows = [{ id: 'post-1', archived_at: null }];
    bundleRows = [{ id: 'bundle-1', post_id: 'post-1' }];
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    createServiceClientFactory.mockImplementation(() => createServiceClientMock());
    showcaseCacheMocks.invalidate.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 10,
        remaining: 9,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'reporter-1' } },
          error: null,
        })),
      },
    });
  });

  it('does not create an admin client for unauthenticated reports', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/report/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-token',
          'x-request-id': 'post-report-auth-1',
        },
        body: JSON.stringify({ reason: 'spam' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'post-report-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(insertedReports).toEqual([]);
  });

  it('rejects invalid report reasons before creating a privileged client', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/report/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'post-report-invalid-1',
        },
        body: JSON.stringify({ reason: 'not-a-real-reason' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'post-report-invalid-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(insertedReports).toEqual([]);
  });

  it('records post reports without an unlock bundle', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/report/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'post-report-success-1',
        },
        body: JSON.stringify({ reason: 'spam' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'post-report-success-1');
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-report:submit',
      p_subject_key: 'reporter-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(insertedReports).toEqual([
      {
        post_id: 'post-1',
        bundle_id: null,
        reporter_user_id: 'reporter-1',
        reason: 'spam',
        details: null,
      },
    ]);
    expect(showcaseCacheMocks.invalidate).toHaveBeenCalledOnce();
  });

  it('rate limits repeated post reports before inserting', async () => {
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 10,
        remaining: 0,
        retryAfterSeconds: 55,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/posts/[postId]/report/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'post-report-rate-limit-1',
        },
        body: JSON.stringify({ reason: 'spam' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('55');
    expectPrivateNoStoreTraceHeaders(response, 'post-report-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-report:submit',
      p_subject_key: 'reporter-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(insertedReports).toEqual([]);
    expect(showcaseCacheMocks.invalidate).not.toHaveBeenCalled();
  });

  it('rejects unlock reports for bundles attached to another post', async () => {
    bundleRows = [{ id: 'bundle-2', post_id: 'post-2' }];

    const { POST } = await import('@/app/api/posts/[postId]/report/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'misleading_unlock', bundleId: 'bundle-2' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toContain('does not belong');
    expect(insertedReports).toEqual([]);
  });

  it('records unlock reports only when the bundle belongs to the post', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/report/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'misleading_unlock', bundleId: 'bundle-1' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expect(insertedReports).toEqual([
      {
        post_id: 'post-1',
        bundle_id: 'bundle-1',
        reporter_user_id: 'reporter-1',
        reason: 'misleading_unlock',
        details: null,
      },
    ]);
  });
});
