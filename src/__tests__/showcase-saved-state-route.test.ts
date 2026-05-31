import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type QueryResult<T> = {
  data: T[];
  error: null | { code?: string; message?: string };
};

const getUserMock = vi.fn(async () => ({
  data: {
    user: { id: 'user-1' },
  },
  error: null,
}));

const postSavesResultMock = vi.fn<() => Promise<QueryResult<{ post_id: string }>>>();
const legacySavesResultMock = vi.fn<() => Promise<QueryResult<{ generation_id: string }>>>();

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: () => getUserMock(),
    },
    from(table: string) {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        in: vi.fn(() => {
          if (table === 'post_saves') {
            return postSavesResultMock();
          }

          if (table === 'showcase_saves') {
            return legacySavesResultMock();
          }

          return Promise.resolve({ data: [], error: null });
        }),
      };

      return query;
    },
  }),
}));

describe('/api/showcase/saved-state route', () => {
  beforeEach(() => {
    vi.resetModules();
    getUserMock.mockClear();
    postSavesResultMock.mockReset();
    legacySavesResultMock.mockReset();
    getUserMock.mockResolvedValue({
      data: {
        user: { id: 'user-1' },
      },
      error: null,
    });
    postSavesResultMock.mockResolvedValue({
      data: [{ post_id: 'post-1' }],
      error: null,
    });
    legacySavesResultMock.mockResolvedValue({
      data: [],
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns saved public post ids from post_saves', async () => {
    const { GET } = await import('@/app/api/showcase/saved-state/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-state?ids=post-1,post-2')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(['post-1']);
    expect(postSavesResultMock).toHaveBeenCalledTimes(1);
    expect(legacySavesResultMock).not.toHaveBeenCalled();
  });

  it('falls back to legacy showcase_saves when post_saves is not available', async () => {
    postSavesResultMock.mockResolvedValueOnce({
      data: [],
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.post_saves'",
      },
    });
    legacySavesResultMock.mockResolvedValueOnce({
      data: [{ generation_id: 'gen-1' }],
      error: null,
    });

    const { GET } = await import('@/app/api/showcase/saved-state/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-state?ids=post-1,gen-1')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(['gen-1']);
    expect(postSavesResultMock).toHaveBeenCalledTimes(1);
    expect(legacySavesResultMock).toHaveBeenCalledTimes(1);
  });
});
