import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPostMediaRouteResponse } from '@/lib/post-media-route-adapter-service';
const path = 'private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg';
it('serves a public post signed out without making its redirect cacheable', async () => {
  const admin = {} as SupabaseClient;
  const read = vi.fn(async () => 'https://storage.test/signed');
  const response = await getPostMediaRouteResponse(new Request(`https://app.test/api/media?bucket=post_media&path=${path}`), {
    createServiceClient: () => admin,
    createMediaSupabaseClient: async () => admin,
    requireIdentity: async () => ({ ok: false, status: 401, error: 'Unauthorized', code: 'UNAUTHORIZED' }),
    readPostMedia: read,
  });
  expect(response.status).toBe(302);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Vary')).toBe('Authorization, Cookie');
  expect(read).toHaveBeenCalledWith({ admin, path, viewerUserId: null });
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
    requireIdentity: async () => ({ ok: false, status: 401, error: 'Unauthorized', code: 'UNAUTHORIZED' }),
    readPostMedia: read,
  });
  expect(response.status).toBe(401);
  expect(read).not.toHaveBeenCalled();
});
