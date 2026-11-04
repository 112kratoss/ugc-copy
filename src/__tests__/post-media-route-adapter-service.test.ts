import { expect, it, vi } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { IdentityResult } from '@/lib/account-identity';
import { getPostMediaRouteResponse } from '@/lib/post-media-route-adapter-service';
const path = 'private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg';
const signedOut = async (): Promise<IdentityResult> => ({ ok: false, status: 401, error: 'Unauthorized', code: 'UNAUTHORIZED' });

it('lets the viewer\'s own browser keep the redirect to a public post\'s media', async () => {
  const admin = {} as SupabaseClient;
  const read = vi.fn(async () => ({ signedUrl: 'https://storage.test/signed', browserCacheSeconds: 3000 }));
  const response = await getPostMediaRouteResponse(new Request(`https://app.test/api/media?bucket=post_media&path=${path}`), {
    createServiceClient: () => admin,
    createMediaSupabaseClient: async () => admin,
    requireIdentity: signedOut,
    readPostMedia: read,
  });
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe('https://storage.test/signed');
  // Never `public` or `s-maxage`: no shared cache keeps it.
  expect(response.headers.get('Cache-Control')).toBe('private, max-age=3000');
  expect(response.headers.get('Vary')).toBe('Authorization, Cookie');
  expect(read).toHaveBeenCalledWith({ admin, path, viewerUserId: null });
});

it('keeps every other redirect uncacheable, so it is authorized again at its next request', async () => {
  const admin = {} as SupabaseClient;
  const read = vi.fn(async () => ({ signedUrl: 'https://storage.test/owner-only', browserCacheSeconds: 0 }));
  const response = await getPostMediaRouteResponse(new Request(`https://app.test/api/media?bucket=post_media&path=${path}`, {
    headers: { Authorization: 'Bearer owner' },
  }), {
    createServiceClient: () => admin,
    createMediaSupabaseClient: async () => admin,
    requireIdentity: async (): Promise<IdentityResult> => ({
      ok: true,
      identity: { userId: 'owner', kind: 'registered', isGuest: false, user: { id: 'owner' } as User },
    }),
    readPostMedia: read,
  });
  expect(response.status).toBe(302);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Vary')).toBe('Authorization, Cookie');
  expect(read).toHaveBeenCalledWith({ admin, path, viewerUserId: 'owner' });
});

it('answers a refused read with an uncacheable 404', async () => {
  const admin = {} as SupabaseClient;
  const response = await getPostMediaRouteResponse(new Request(`https://app.test/api/media?bucket=post_media&path=${path}`), {
    createServiceClient: () => admin,
    createMediaSupabaseClient: async () => admin,
    requireIdentity: signedOut,
    readPostMedia: vi.fn(async () => null),
  });
  expect(response.status).toBe(404);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
});

it('rejects a forged path before creating privileged clients', async () => {
  const createServiceClient = vi.fn();
  const response = await getPostMediaRouteResponse(new Request('https://app.test/api/media?bucket=post_media&path=private-posts%2Fwrong%2Fx'), { createServiceClient });
  expect(response.status).toBe(400);
  expect(createServiceClient).not.toHaveBeenCalled();
});

it('does not treat an explicitly invalid bearer as a signed-out visitor', async () => {
  const admin = {} as SupabaseClient;
  const read = vi.fn();
  const response = await getPostMediaRouteResponse(new Request(`https://app.test/api/media?bucket=post_media&path=${path}`, {
    headers: { Authorization: 'Bearer invalid' },
  }), {
    createServiceClient: () => admin,
    createMediaSupabaseClient: async () => admin,
    requireIdentity: signedOut,
    readPostMedia: read,
  });
  expect(response.status).toBe(401);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(read).not.toHaveBeenCalled();
});
