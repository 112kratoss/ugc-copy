import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { agentPostState, readPostForAgent, toAgentPostView } from '@/lib/agent-post-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    user_id: OWNER,
    generation_id: '44444444-4444-4444-8444-444444444444',
    title: 'Red bicycle',
    description: null,
    body: 'At dawn.',
    category: 'image',
    visibility: 'public',
    review_status: 'visible',
    archived_at: null,
    tombstoned_at: null,
    is_nsfw: false,
    remixes_allowed: true,
    save_count: 3,
    comment_count: null,
    remix_count: 1,
    share_count: -2,
    created_at: '2026-11-09T10:00:00Z',
    ...overrides,
  };
}

function admin(data: unknown, error: unknown = null) {
  const maybeSingle = vi.fn(async () => ({ data, error }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as SupabaseClient, from, select, eq };
}

describe('a post as an agent reads it', () => {
  it('derives the post page\'s state: removed before archived before hidden before visibility', () => {
    expect(agentPostState(row())).toBe('live');
    expect(agentPostState(row({ visibility: 'private' }))).toBe('private');
    expect(agentPostState(row({ review_status: 'hidden' }))).toBe('hidden');
    expect(agentPostState(row({ archived_at: '2026-11-09T11:00:00Z', review_status: 'hidden' }))).toBe('archived');
    expect(agentPostState(row({ tombstoned_at: '2026-11-09T11:00:00Z', archived_at: '2026-11-09T11:00:00Z' }))).toBe('removed');
    expect(agentPostState(row({ review_status: null }))).toBe('live');
  });

  it('shapes the view with the counts the page shows, never negative or missing', () => {
    const view = toAgentPostView(row(), OWNER);
    expect(view).toEqual({
      postId: POST_ID,
      ownerUserId: OWNER,
      generationId: '44444444-4444-4444-8444-444444444444',
      title: 'Red bicycle',
      description: null,
      body: 'At dawn.',
      category: 'image',
      visibility: 'public',
      state: 'live',
      isNsfw: false,
      remixesAllowed: true,
      counts: { saves: 3, comments: 0, remixes: 1, shares: 0 },
      createdAt: '2026-11-09T10:00:00Z',
      isOwn: true,
    });
    expect(toAgentPostView(row({ remixes_allowed: null, is_nsfw: true, visibility: 'unlisted' }), OTHER)).toMatchObject({
      remixesAllowed: true, isNsfw: true, visibility: 'private', state: 'private', isOwn: false,
    });
  });

  it('shows the owner every state, anyone else only a live post, and reads with the service client', async () => {
    const live = admin(row());
    expect(await readPostForAgent(live.client, { postId: POST_ID, viewerUserId: OTHER })).toMatchObject({ ok: true, post: { state: 'live', isOwn: false } });
    expect(live.from).toHaveBeenCalledWith('posts');
    expect(live.eq).toHaveBeenCalledWith('id', POST_ID);

    const ownPrivate = admin(row({ visibility: 'private' }));
    expect(await readPostForAgent(ownPrivate.client, { postId: POST_ID, viewerUserId: OWNER })).toMatchObject({ ok: true, post: { state: 'private', isOwn: true } });

    for (const hidden of [row({ visibility: 'private' }), row({ review_status: 'hidden' }), row({ archived_at: 'x' }), row({ tombstoned_at: 'x' })]) {
      expect(await readPostForAgent(admin(hidden).client, { postId: POST_ID, viewerUserId: OTHER })).toEqual({ ok: false, code: 'NOT_FOUND' });
    }
    expect(await readPostForAgent(admin(null).client, { postId: POST_ID, viewerUserId: OWNER })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await readPostForAgent(admin(null, { message: 'down' }).client, { postId: POST_ID, viewerUserId: OWNER })).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});
