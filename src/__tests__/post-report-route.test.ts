import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const insertedReports: unknown[] = [];

let postRows: Array<{ id: string; archived_at: string | null }> = [];
let bundleRows: Array<{ id: string; post_id: string }> = [];

function createServiceClientMock() {
  return {
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

describe('/api/posts/[postId]/report route', () => {
  beforeEach(() => {
    vi.resetModules();
    insertedReports.length = 0;
    postRows = [{ id: 'post-1', archived_at: null }];
    bundleRows = [{ id: 'bundle-1', post_id: 'post-1' }];
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    createServiceClientFactory.mockImplementation(() => createServiceClientMock());
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'spam' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(insertedReports).toEqual([]);
  });

  it('records post reports without an unlock bundle', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/report/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'spam' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expect(insertedReports).toEqual([
      {
        post_id: 'post-1',
        bundle_id: null,
        reporter_user_id: 'reporter-1',
        reason: 'spam',
        details: null,
      },
    ]);
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
