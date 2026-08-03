import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordProfileShareEventMock = vi.fn(async (payload?: unknown, client?: unknown) => {
  void payload;
  void client;
});
const findShareableProfileByUsernameMock =
  vi.fn<(username?: string) => Promise<{ id: string; username: string } | null>>();
const createUserClientMock = vi.fn();
const rpcMock = vi.fn();
const createServiceClientMock = vi.fn(() => ({ service: true, rpc: rpcMock }));

vi.mock('@/lib/profile-share-events', () => ({
  recordProfileShareEvent: (payload: unknown, client: unknown) =>
    recordProfileShareEventMock(payload, client),
}));

vi.mock('@/lib/profile-server', () => ({
  findShareableProfileByUsername: (username: string) => findShareableProfileByUsernameMock(username),
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

function shareRequest(body: unknown, requestId: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/profile/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, ...headers },
    body: JSON.stringify(body),
  });
}

describe('/api/profile/share route', () => {
  beforeEach(() => {
    vi.resetModules();
    recordProfileShareEventMock.mockClear();
    findShareableProfileByUsernameMock.mockReset();
    createUserClientMock.mockReset();
    createServiceClientMock.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-08-03T06:30:00.000Z',
      },
      error: null,
    });
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a creator profile share through the whole stack', async () => {
    findShareableProfileByUsernameMock.mockResolvedValue({ id: 'creator-1', username: 'nova' });
    const { POST } = await import('@/app/api/profile/share/route');

    const response = await POST(shareRequest(
      { username: 'nova', sourceSurface: 'creator-profile', channel: 'native-share' },
      'profile-share-1',
    ) as never);

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-share-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(recordProfileShareEventMock).toHaveBeenCalledWith(
      {
        profileUserId: 'creator-1',
        eventType: 'share_click',
        sourceSurface: 'creator-profile',
        channel: 'native-share',
        actorUserId: 'user-1',
      },
      expect.objectContaining({ service: true }),
    );
  });

  it('returns 404 for a username no profile owns', async () => {
    findShareableProfileByUsernameMock.mockResolvedValue(null);
    const { POST } = await import('@/app/api/profile/share/route');

    const response = await POST(shareRequest(
      { username: 'ghost', sourceSurface: 'creator-profile', channel: 'copy-link' },
      'profile-share-2',
    ) as never);

    expect(response.status).toBe(404);
    expectPrivateNoStoreTraceHeaders(response, 'profile-share-2');
    expect(recordProfileShareEventMock).not.toHaveBeenCalled();
  });

  it('rate limits anonymous callers by network key before any profile lookup', async () => {
    createUserClientMock.mockReturnValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
    });
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 120,
        remaining: 0,
        retryAfterSeconds: 30,
        resetAt: '2026-08-03T06:35:00.000Z',
      },
      error: null,
    });
    const { POST } = await import('@/app/api/profile/share/route');

    const response = await POST(shareRequest(
      { username: 'nova', sourceSurface: 'creator-profile', channel: 'copy-link' },
      'profile-share-3',
      { 'x-forwarded-for': '203.0.113.7' },
    ) as never);

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'profile-share-3');
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', expect.objectContaining({
      p_scope: 'profile:share',
      p_subject_key: '203.0.113.7',
    }));
    expect(findShareableProfileByUsernameMock).not.toHaveBeenCalled();
    expect(recordProfileShareEventMock).not.toHaveBeenCalled();
  });
});
