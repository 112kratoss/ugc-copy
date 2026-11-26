import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const service = vi.hoisted(() => ({
  listAdminSupportHub: vi.fn(),
  publishSupportUpdate: vi.fn(),
  announceSupportUpdate: vi.fn(),
  runSupportUpdateBroadcastQuietly: vi.fn(async () => undefined),
  editSupportUpdate: vi.fn(),
  setSupportUpdateCommentsLocked: vi.fn(),
  setSupportUpdatePublished: vi.fn(),
  createRoadmapItem: vi.fn(),
  updateRoadmapItem: vi.fn(),
  setRoadmapItemArchived: vi.fn(),
  moveRoadmapItem: vi.fn(),
  shipRoadmapItem: vi.fn(),
}));

vi.mock('@/lib/admin-support-hub-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/admin-support-hub-service')>();
  return { ...original, ...service };
});

import { getAdminSupportHub, postAdminSupportHubAction } from '@/lib/admin-support-hub-route-adapter-service';

const POST_ID = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const ITEM_ID = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';

const admitted = vi.fn(async () => ({ authenticated: true }) as never);
const refused = vi.fn(async () => ({ authenticated: false, reason: 'missing' }) as never);

function deps(overrides: Record<string, unknown> = {}) {
  return {
    authenticateAdminRequest: admitted,
    createServiceClient: vi.fn(() => ({}) as unknown as SupabaseClient),
    runAfter: vi.fn((task: () => Promise<void>) => void task()),
    ...overrides,
  };
}

const post = (body: unknown) => new Request('https://magicbooklet.test/api/admin/support-hub', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  service.runSupportUpdateBroadcastQuietly.mockResolvedValue(undefined);
});

describe('/api/admin/support-hub', () => {
  it('answers no one without the operator\'s session', async () => {
    const read = await getAdminSupportHub(new Request('https://magicbooklet.test/api/admin/support-hub'), deps({ authenticateAdminRequest: refused }));
    expect(read.status).toBe(401);
    const write = await postAdminSupportHubAction(post({ action: 'publish' }), deps({ authenticateAdminRequest: refused }));
    expect(write.status).toBe(401);
    expect(service.publishSupportUpdate).not.toHaveBeenCalled();
  });

  it('reads every update and the roadmap, never cached', async () => {
    service.listAdminSupportHub.mockResolvedValue({ officialAccountReady: true, updates: [], roadmap: [] });
    const response = await getAdminSupportHub(new Request('https://magicbooklet.test/api/admin/support-hub'), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ success: true, officialAccountReady: true, updates: [], roadmap: [] });
  });

  it('publishes, then sends an announced update\'s alerts behind the response', async () => {
    service.publishSupportUpdate.mockResolvedValue({ ok: true, value: { postId: POST_ID, announced: true } });
    const d = deps();
    const response = await postAdminSupportHubAction(post({
      action: 'publish', kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: true, announce: 'alert',
    }), d);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, postId: POST_ID, announced: true });
    expect(service.publishSupportUpdate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'announcement', commentsLocked: true, announce: 'alert' }));
    expect(d.runAfter).toHaveBeenCalledTimes(1);
    expect(service.runSupportUpdateBroadcastQuietly).toHaveBeenCalledWith(expect.objectContaining({ postId: POST_ID }));
  });

  it('starts no broadcast for a quiet update, and refuses an unknown audience', async () => {
    service.publishSupportUpdate.mockResolvedValue({ ok: true, value: { postId: POST_ID, announced: false } });
    const d = deps();
    await postAdminSupportHubAction(post({ action: 'publish', kind: 'announcement', title: 'Hi', body: 'There', announce: 'quiet' }), d);
    expect(d.runAfter).not.toHaveBeenCalled();

    const response = await postAdminSupportHubAction(post({ action: 'publish', announce: 'everyone' }), deps());
    expect(response.status).toBe(400);
  });

  it('announces a quiet update later, and sends its alerts behind the response', async () => {
    service.announceSupportUpdate.mockResolvedValue({ ok: true, value: { postId: POST_ID } });
    const d = deps();
    const response = await postAdminSupportHubAction(post({ action: 'announce', postId: POST_ID }), d);

    expect(response.status).toBe(200);
    // Alerts in the app only: no push is asked for or passed on.
    expect(service.announceSupportUpdate).toHaveBeenCalledWith({ adminSupabase: expect.anything(), postId: POST_ID });
    expect(service.runSupportUpdateBroadcastQuietly).toHaveBeenCalledWith(expect.objectContaining({ postId: POST_ID }));

    service.announceSupportUpdate.mockResolvedValue({ ok: false, status: 409, error: 'That update was already announced. Use Continue sending if it stopped short.' });
    const again = await postAdminSupportHubAction(post({ action: 'announce', postId: POST_ID }), deps());
    expect(again.status).toBe(409);
  });

  it('passes a refusal on with its words', async () => {
    service.shipRoadmapItem.mockResolvedValue({ ok: false, status: 409, error: 'Choose a published update to ship it with.' });
    const response = await postAdminSupportHubAction(post({ action: 'roadmapShip', itemId: ITEM_ID, updatePostId: POST_ID }), deps());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Choose a published update to ship it with.' });
  });

  it('refuses an unknown action and a missing id', async () => {
    expect((await postAdminSupportHubAction(post({ action: 'drop' }), deps())).status).toBe(400);
    expect((await postAdminSupportHubAction(post({ action: 'lock', postId: 'nope', locked: true }), deps())).status).toBe(400);
    expect((await postAdminSupportHubAction(post({ action: 'roadmapMove', itemId: ITEM_ID, direction: 'sideways' }), deps())).status).toBe(400);
  });

  it('answers a failure with words, not the error', async () => {
    service.setSupportUpdateCommentsLocked.mockRejectedValue(new Error('database down'));
    const response = await postAdminSupportHubAction(post({ action: 'lock', postId: POST_ID, locked: true }), deps());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'That did not go through. Try again.' });
  });
});
