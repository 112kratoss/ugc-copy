import { describe, expect, it, vi } from 'vitest';

import {
  getViewerUnlockDetailRouteResponse,
  postViewerUnlockFileUrlRouteResponse,
} from '@/lib/viewer-unlock-detail-route-adapter-service';

const UNLOCK_ID = '11111111-1111-4111-8111-111111111111';

function request(method = 'GET', body?: unknown) {
  return new Request(`https://example.test/api/me/unlocks/${UNLOCK_ID}`, {
    method,
    headers: { Authorization: 'Bearer buyer-token', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const authenticatedClient = (() => ({
  auth: {
    getUser: vi.fn(async () => ({ data: { user: { id: 'buyer-1' } }, error: null })),
  },
})) as never;

describe('viewer unlock detail routes', () => {
  it('loads by purchase UUID for the authenticated buyer with private no-store headers', async () => {
    const getViewerUnlockDetail = vi.fn(async () => ({ unlockId: UNLOCK_ID }));
    const response = await getViewerUnlockDetailRouteResponse({
      request: request(),
      context: { params: Promise.resolve({ unlockId: UNLOCK_ID }) },
      dependencies: {
        createUserClient: authenticatedClient,
        createServiceClient: (() => ({})) as never,
        getViewerUnlockDetail: getViewerUnlockDetail as never,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getViewerUnlockDetail).toHaveBeenCalledWith(expect.objectContaining({
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    }));
  });

  it('returns the same 404 for an unowned or moderation-retracted purchase', async () => {
    const response = await getViewerUnlockDetailRouteResponse({
      request: request(),
      context: { params: Promise.resolve({ unlockId: UNLOCK_ID }) },
      dependencies: {
        createUserClient: authenticatedClient,
        createServiceClient: (() => ({})) as never,
        getViewerUnlockDetail: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Unlock not found.' });
  });

  it('passes only the buyer-scoped file request to the retained file resolver', async () => {
    const createViewerUnlockFileUrl = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const, signedUrl: 'https://signed.example.test/file' },
    }));
    const response = await postViewerUnlockFileUrlRouteResponse({
      request: request('POST', { storagePath: 'buyer/path.pdf' }),
      context: { params: Promise.resolve({ unlockId: UNLOCK_ID }) },
      dependencies: {
        createUserClient: authenticatedClient,
        createServiceClient: (() => ({})) as never,
        createViewerUnlockFileUrl: createViewerUnlockFileUrl as never,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(createViewerUnlockFileUrl).toHaveBeenCalledWith(expect.objectContaining({
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
      body: { storagePath: 'buyer/path.pdf' },
    }));
  });
});
