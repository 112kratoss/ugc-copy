import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientFactory = vi.fn(() => ({ service: 'admin' }));
const notifyCreatorFollowedMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyCreatorFollowed: (...args: unknown[]) => notifyCreatorFollowedMock(...args),
}));

describe('/api/profile/follow/notify route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    notifyCreatorFollowedMock.mockClear();
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });
  });

  it('does not create an admin client before authentication succeeds', async () => {
    const { POST } = await import('@/app/api/profile/follow/notify/route');
    const response = await POST(
      new Request('http://localhost/api/profile/follow/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followingId: 'creator-1' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(notifyCreatorFollowedMock).not.toHaveBeenCalled();
  });
});
