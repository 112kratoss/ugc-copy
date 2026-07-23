import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordPostShareEventMock = vi.fn(async (payload?: unknown) => {
  void payload;
});
const notifyPostSocialActivityMock = vi.fn(async (client?: unknown, payload?: unknown) => {
  void client;
  void payload;
});
const findPublicPostReferenceByIdOrGenerationIdMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
const createUserClientMock = vi.fn();
const rpcMock = vi.fn();
const createServiceClientMock = vi.fn(() => ({ service: true, rpc: rpcMock }));

vi.mock('@/lib/post-share-events', () => ({
  recordPostShareEvent: (payload: unknown) => recordPostShareEventMock(payload),
}));

vi.mock('@/lib/posts-server', () => ({
  findPublicPostReferenceByIdOrGenerationId: (id: string) =>
    findPublicPostReferenceByIdOrGenerationIdMock(id),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyPostSocialActivity: (client: unknown, payload: unknown) => notifyPostSocialActivityMock(client, payload),
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

describe('/api/showcase/share route', () => {
  beforeEach(() => {
    vi.resetModules();
    recordPostShareEventMock.mockClear();
    notifyPostSocialActivityMock.mockClear();
    findPublicPostReferenceByIdOrGenerationIdMock.mockReset();
    createUserClientMock.mockReset();
    createServiceClientMock.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
        })),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records share clicks for public posts', async () => {
    findPublicPostReferenceByIdOrGenerationIdMock.mockResolvedValue({
      id: 'post-1',
      generation_id: 'gen-1',
      user_id: 'creator-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'magicbooklet',
    });

    const { POST } = await import('@/app/api/showcase/share/route');
    const response = await POST(
      new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-request-id': 'showcase-share-success-1',
        },
        body: JSON.stringify({
          generationId: 'gen-1',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'showcase-share-success-1');
    expect(data.success).toBe(true);
    expect(recordPostShareEventMock).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_click',
      sourceSurface: 'showcase',
      channel: 'copy-link',
      actorUserId: 'user-1',
    });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase:share',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(notifyPostSocialActivityMock).toHaveBeenCalledWith({ service: true, rpc: rpcMock }, {
      type: 'post_shared',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it('rejects private or missing posts', async () => {
    findPublicPostReferenceByIdOrGenerationIdMock.mockResolvedValue(null);

    const { POST } = await import('@/app/api/showcase/share/route');
    const response = await POST(
      new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'showcase-share-missing-1',
        },
        body: JSON.stringify({
          postId: 'post-2',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(404);
    expectPrivateNoStoreTraceHeaders(response, 'showcase-share-missing-1');
    expect(data.error).toContain('public creations');
    expect(recordPostShareEventMock).not.toHaveBeenCalled();
  });

  it('rate limits anonymous share tracking before public lookup or event recording', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: null,
        })),
      },
    });
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 120,
        remaining: 0,
        retryAfterSeconds: 30,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/showcase/share/route');
    const response = await POST(
      new Request('http://localhost/api/showcase/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.55, 10.0.0.1',
          'x-request-id': 'showcase-share-rate-limit-1',
        },
        body: JSON.stringify({
          postId: 'post-2',
          sourceSurface: 'showcase',
          channel: 'copy-link',
        }),
      }) as never
    );

    const data = await response.json();
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expectPrivateNoStoreTraceHeaders(response, 'showcase-share-rate-limit-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase:share',
      p_subject_key: '203.0.113.55',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(findPublicPostReferenceByIdOrGenerationIdMock).not.toHaveBeenCalled();
    expect(recordPostShareEventMock).not.toHaveBeenCalled();
    expect(notifyPostSocialActivityMock).not.toHaveBeenCalled();
  });
});
