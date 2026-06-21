import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());
const getUserMock = vi.fn();
const userFromMock = vi.fn();
const serviceRpcMock = vi.fn();
const createServiceClientMock = vi.fn();
const findPublicPostReferenceByIdOrGenerationIdMock = vi.fn();
const notifyPostSocialActivityMock = vi.fn();

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

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

async function postRemix(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/showcase/remix/route');
  return POST(
    new Request('http://localhost/api/showcase/remix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
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
    userFromMock.mockImplementation((table: string) => {
      if (table !== 'generations') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  return {
                    data: {
                      id: 'gen-1',
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
    serviceRpcMock.mockResolvedValue({ data: true, error: null });
    createServiceClientMock.mockReset();
    createServiceClientMock.mockReturnValue({ rpc: serviceRpcMock });
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

  it('remixes public generation-backed posts through the shared user client', async () => {
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
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(serviceRpcMock).toHaveBeenCalledWith('increment_post_remix_count', {
      p_post_id: 'post-1',
    });
    expect(notifyPostSocialActivityMock).toHaveBeenCalledWith(expect.anything(), {
      type: 'post_remixed',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });
});
