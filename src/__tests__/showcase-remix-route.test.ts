import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());
const getUserMock = vi.fn();
const userFromMock = vi.fn();
const serviceRpcMock = vi.fn();
const createServiceClientMock = vi.fn();
const findPublicPostReferenceByIdOrGenerationIdMock = vi.fn();
const notifyPostSocialActivityMock = vi.fn();
let rateLimitAllowed = true;

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => rawCreateClientMock(...args),
}));

vi.mock('@/lib/posts-server', () => ({
  findPublicPostReferenceByIdOrGenerationId: (id: string) =>
    findPublicPostReferenceByIdOrGenerationIdMock(id),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyPostSocialActivity: (client: unknown, payload: unknown) =>
    notifyPostSocialActivityMock(client, payload),
}));

vi.mock('@/lib/moderation-service', () => ({
  isUserRelationshipBlocked: vi.fn(async () => false),
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

async function postRemix(body: Record<string, unknown>, requestId = 'showcase-remix-success-1') {
  const { POST } = await import('@/app/api/showcase/remix/route');
  return POST(
    new Request('http://localhost/api/showcase/remix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'x-request-id': requestId,
      },
      body: JSON.stringify(body),
    }) as never
  );
}

describe('/api/showcase/remix route', () => {
  beforeEach(() => {
    vi.resetModules();
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    userFromMock.mockReset();
    userFromMock.mockImplementation((table: string) => {
      // The hardened grants leave authenticated clients without read access to
      // generation prompts/settings, so the route must never reach the user
      // client for table reads. This mock throwing is the regression guard.
      throw new Error(`Unexpected user-client table read: ${table}`);
    });
    const userClient = {
      auth: { getUser: getUserMock },
      from: userFromMock,
    };
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockReturnValue(userClient);
    createUserClientMock.mockReset();
    createUserClientMock.mockReturnValue(userClient);
    serviceRpcMock.mockReset();
    rateLimitAllowed = true;
    serviceRpcMock.mockImplementation((fn: string) => {
      if (fn === 'check_backend_rate_limit') {
        return Promise.resolve({
          data: {
            allowed: rateLimitAllowed,
            limit: 60,
            remaining: rateLimitAllowed ? 59 : 0,
            retryAfterSeconds: rateLimitAllowed ? 0 : 28,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        });
      }

      return Promise.resolve({ data: true, error: null });
    });
    createServiceClientMock.mockReset();
    createServiceClientMock.mockReturnValue({
      rpc: serviceRpcMock,
      from: (table: string) => {
        if (table !== 'generations') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return {
                      data: {
                        id: 'gen-1',
                        user_id: 'creator-1',
                        is_public: true,
                        share_input_media_for_remix: true,
                        category: 'image',
                        prompt: 'Create a clean UGC product reveal.',
                        workflow_settings: { model: 'nano-banana-2' },
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    });
    findPublicPostReferenceByIdOrGenerationIdMock.mockReset();
    findPublicPostReferenceByIdOrGenerationIdMock.mockResolvedValue({
      id: 'post-1',
      generation_id: 'gen-1',
      user_id: 'creator-1',
      category: 'image',
    });
    notifyPostSocialActivityMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('remixes public generation-backed posts through the service client', async () => {
    const response = await postRemix({ postId: 'post-1' });

    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: '/create-image?remix=gen-1&remixPost=post-1',
      prefill: {
        prompt: 'Create a clean UGC product reveal.',
        settings: { model: 'nano-banana-2' },
      },
    });
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'showcase-remix-success-1');
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(userFromMock).not.toHaveBeenCalled();
    // Opening the editor is not a completed remix. The public count and the
    // creator's notification both wait for a settled generation, so a reader
    // who opens the editor and closes it leaves no trace on either.
    expect(serviceRpcMock).not.toHaveBeenCalledWith(
      'increment_post_remix_count',
      expect.anything(),
    );
    expect(notifyPostSocialActivityMock).not.toHaveBeenCalled();
  });

  it('returns 429 before parsing the remix body when remix capacity is exhausted', async () => {
    rateLimitAllowed = false;
    const jsonMock = vi.fn(async () => ({ postId: 'post-1' }));

    const { POST } = await import('@/app/api/showcase/remix/route');
    const response = await POST({
      headers: new Headers({
        Authorization: 'Bearer token',
        'x-request-id': 'showcase-remix-rate-limit-1',
      }),
      json: jsonMock,
    } as never);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('28');
    expectPrivateNoStoreTraceHeaders(response, 'showcase-remix-rate-limit-1');
    expect(serviceRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase:remix',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(jsonMock).not.toHaveBeenCalled();
    expect(findPublicPostReferenceByIdOrGenerationIdMock).not.toHaveBeenCalled();
    expect(userFromMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivityMock).not.toHaveBeenCalled();
  });
});
