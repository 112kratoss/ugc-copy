import { describe, expect, it, vi } from 'vitest';

import { authenticateRequest } from '@/lib/server-helpers';

describe('shared server route authentication', () => {
  it('resolves the lazy admin factory through the real identity helper', async () => {
    const profileQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({
        data: { identity_state: 'active' },
        error: null,
      })),
    };
    profileQuery.select.mockReturnValue(profileQuery);
    profileQuery.eq.mockReturnValue(profileQuery);
    const createServiceClient = vi.fn(() => ({
      from: vi.fn(() => profileQuery),
    }) as never);
    const userClient = {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1', is_anonymous: false } },
          error: null,
        })),
      },
    };

    const result = await authenticateRequest(
      new Request('https://magicbooklet.test/api/workflow-canvases/canvas-1'),
      {
        createServiceClient,
        createUserClient: vi.fn(() => userClient as never),
      },
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(!(result instanceof Response) && result.userId).toBe('user-1');
    expect(createServiceClient).toHaveBeenCalledOnce();
  });

  it('propagates merged-session rejection before workflow handlers receive an identity', async () => {
    const createServiceClient = vi.fn(() => ({}) as never);
    const response = await authenticateRequest(
      new Request('https://magicbooklet.test/api/workflow-canvases/canvas-1/run'),
      {
        createServiceClient,
        createUserClient: vi.fn(() => ({}) as never),
        requireIdentity: vi.fn(async () => ({
          ok: false as const,
          status: 409 as const,
          code: 'SESSION_MERGED' as const,
          error: 'This guest session has been linked to an account. Sign in to continue.',
        })),
      },
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(409);
    await expect((response as Response).json()).resolves.toMatchObject({
      code: 'SESSION_MERGED',
    });
  });

  it('returns the stable 503 contract when identity state cannot be checked', async () => {
    const response = await authenticateRequest(
      new Request('https://magicbooklet.test/api/workflow-canvases/canvas-1'),
      {
        createServiceClient: vi.fn(() => ({}) as never),
        createUserClient: vi.fn(() => ({}) as never),
        requireIdentity: vi.fn(async () => ({
          ok: false as const,
          status: 503 as const,
          code: 'IDENTITY_CHECK_UNAVAILABLE' as const,
          error: 'Identity verification is temporarily unavailable. Please try again.',
        })),
      },
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
    await expect((response as Response).json()).resolves.toMatchObject({
      code: 'IDENTITY_CHECK_UNAVAILABLE',
    });
  });
});
