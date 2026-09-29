import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  identity: vi.fn(), rpc: vi.fn(), from: vi.fn(), upsert: vi.fn(), remove: vi.fn(),
  detail: vi.fn(), item: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock('@/lib/account-identity', () => ({ requireIdentity: state.identity }));
vi.mock('@/lib/server-helpers', () => ({ createServiceClient: () => ({ rpc: state.rpc, from: state.from }) }));
vi.mock('@/lib/media-route-shared', () => ({ createMediaSupabaseClient: async () => ({}) }));
vi.mock('@/lib/public-posts', () => ({ getPublicPostDetail: state.detail }));
vi.mock('@/lib/showcase-feed', () => ({ getShowcaseFeedItemById: state.item }));
vi.mock('@/lib/backend-rate-limit', async (original) => ({ ...await original<object>(), enforceBackendRateLimit: state.rateLimit }));
import { contentPreferencesResponse, revealNsfwPostResponse } from '@/lib/nsfw-route-adapter-service';
const postId = 'ab290002-1000-4000-8000-000000000001';
const context = { params: Promise.resolve({ postId }) };
function preference(body: unknown, bearer = false, origin = 'https://app.test') {
  return new Request('https://app.test/api/content-preferences', { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer token' } : {}),
  }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks();
  state.identity.mockResolvedValue({ ok: true, identity: { kind: 'registered', userId: 'viewer' } });
  state.rpc.mockResolvedValue({ data: true, error: null });
  state.detail.mockResolvedValue({ id: postId, nsfwRevealed: true });
  state.item.mockResolvedValue({ id: postId, nsfwRevealed: true });
  state.upsert.mockResolvedValue({ error: null });
  state.remove.mockReturnValue({ eq: vi.fn(async () => ({ error: null })) });
  state.from.mockReturnValue({ upsert: state.upsert, delete: state.remove });
});
it('rejects anonymous identities without accessing preferences or originals', async () => {
  state.identity.mockResolvedValue({ ok: true, identity: { kind: 'guest', userId: 'guest' } });
  expect((await contentPreferencesResponse(preference({ showMature: true, confirmAdult: true }))).status).toBe(401);
  expect(state.upsert).not.toHaveBeenCalled();
});
it('requires website origin and explicit adult confirmation; bearer clients cannot opt in', async () => {
  expect((await contentPreferencesResponse(preference({ showMature: true }))).status).toBe(400);
  expect((await contentPreferencesResponse(preference({ showMature: true, confirmAdult: true }, true))).status).toBe(403);
  expect((await contentPreferencesResponse(preference({ showMature: true, confirmAdult: true }, false, 'https://other.test'))).status).toBe(403);
  expect(state.upsert).not.toHaveBeenCalled();
});
it('stores a website preference and revokes existing reveals without caching', async () => {
  const response = await contentPreferencesResponse(preference({ showMature: false }));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(state.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'viewer', show_mature: false, adult_confirmed_at: null }));
  expect(state.remove).toHaveBeenCalled();
});
it('does not hydrate originals when the database denies disclosure', async () => {
  state.rpc.mockResolvedValue({ data: false, error: null });
  const response = await revealNsfwPostResponse(new Request(`https://app.test/api/posts/${postId}/reveal`, { method: 'POST', headers: { Authorization: 'Bearer token' } }), context);
  expect(response.status).toBe(403);
  expect(state.detail).not.toHaveBeenCalled();
  expect(state.item).not.toHaveBeenCalled();
});
it('binds a reveal to the authenticated viewer, serves private uncached detail', async () => {
  const response = await revealNsfwPostResponse(new Request(`https://app.test/api/posts/${postId}/reveal`, { method: 'POST', headers: { Origin: 'https://app.test' } }), context);
  expect(response.status).toBe(200);
  expect(state.rpc).toHaveBeenCalledWith('reveal_nsfw_post', { p_post_id: postId, p_viewer_id: 'viewer' });
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect((await response.json()).expiresInSeconds).toBe(600);
});
