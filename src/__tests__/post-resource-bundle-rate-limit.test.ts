import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const createUserClientMock = vi.fn();
const createServiceClientMock = vi.fn();
const rateLimitRpcMock = vi.fn();
const getBundleForOrderByPostIdMock = vi.fn();
const savePostResourceBundleMock = vi.fn();
const notifyPostResourceUnlockCompletedMock = vi.fn();
const orderInsertMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getBundleForOrderByPostId: (...args: unknown[]) => getBundleForOrderByPostIdMock(...args),
  getMarketplaceQualityErrorForPostBundle: vi.fn(),
  getPostResourceBundleDetailByPostId: vi.fn(),
  savePostResourceBundle: (...args: unknown[]) => savePostResourceBundleMock(...args),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyPostResourceUnlockCompleted: (...args: unknown[]) => notifyPostResourceUnlockCompletedMock(...args),
}));

function createQuery(result: { data: unknown; error: { message: string } | null }) {
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    maybeSingle: vi.fn(async () => result),
  };
  return query;
}

function createUserSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from(table: string) {
      if (table !== 'posts') {
        throw new Error(`Unexpected user table: ${table}`);
      }

      return createQuery({
        data: {
          id: 'post-1',
          user_id: 'user-1',
          title: 'Draft post',
          body: 'Useful unlock details.',
          visibility: 'private',
          archived_at: null,
          review_status: 'visible',
          showcase_asset_path: null,
          output_url: null,
        },
        error: null,
      });
    },
  };
}

function createAdminSupabaseMock() {
  return {
    rpc: rateLimitRpcMock,
    from(table: string) {
      if (table === 'post_resource_bundle_purchases') {
        return createQuery({ data: null, error: null });
      }

      if (table === 'post_resource_bundle_orders') {
        return {
          insert(payload: Record<string, unknown>) {
            orderInsertMock(payload);
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`Unexpected admin table: ${table}`);
    },
  };
}

function denyRateLimit(retryAfterSeconds = 29) {
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

describe('post resource bundle route rate limits', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientMock.mockReset();
    rateLimitRpcMock.mockReset();
    getBundleForOrderByPostIdMock.mockReset();
    savePostResourceBundleMock.mockReset();
    notifyPostResourceUnlockCompletedMock.mockReset();
    orderInsertMock.mockReset();
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
    createServiceClientMock.mockReturnValue(createAdminSupabaseMock());
    getBundleForOrderByPostIdMock.mockResolvedValue({
      id: 'bundle-1',
      post_id: 'post-1',
      owner_user_id: 'owner-1',
      status: 'published',
      access_mode: 'free',
      price_usd_cents: 0,
    });
    savePostResourceBundleMock.mockResolvedValue({
      id: 'bundle-1',
      status: 'draft',
    });
    notifyPostResourceUnlockCompletedMock.mockResolvedValue(undefined);
    denyRateLimit();
  });

  it('returns 429 before loading a free unlock bundle when free unlock capacity is exhausted', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-free/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-free', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      }) as NextRequest,
      { params: Promise.resolve({ postId: 'post-1' }) },
    );

    expect(response.status).toBe(429);
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-free-unlock:open',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(orderInsertMock).not.toHaveBeenCalled();
    expect(notifyPostResourceUnlockCompletedMock).not.toHaveBeenCalled();
  });

  it('returns 429 before parsing paid unlock verification when verification capacity is exhausted', async () => {
    denyRateLimit(17);
    const jsonMock = vi.fn(async () => ({}));

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/verify/route');
    const response = await POST({
      headers: new Headers({
        Authorization: 'Bearer token',
      }),
      json: jsonMock,
    } as unknown as NextRequest);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-order:verify',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(jsonMock).not.toHaveBeenCalled();
  });
});
