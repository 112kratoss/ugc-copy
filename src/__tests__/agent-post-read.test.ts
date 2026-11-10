import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { AGENT_POST_NO_RESOURCE, agentPostSource, agentPostState, countPostMediaForAgent, readPostForAgent, toAgentPostResource, toAgentPostView } from '@/lib/agent-post-read';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    user_id: OWNER,
    generation_id: '44444444-4444-4444-8444-444444444444',
    post_format: 'media',
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

function bundleRow(overrides: Record<string, unknown> = {}) {
  return { access_mode: 'paid', price_usd_cents: 250, status: 'published', retired_at: null, ...overrides };
}

/** A service client that answers the post's row, then its resource's row, and keeps what was asked of each table. */
function admin(data: unknown, error: unknown = null, resource: { data?: unknown; error?: unknown } = {}) {
  const selects: Record<string, string[]> = {};
  const eq = vi.fn();
  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      (selects[table] ??= []).push(columns);
      return {
        eq: (column: string, value: unknown) => {
          eq(column, value);
          return {
            maybeSingle: async () => (table === 'posts'
              ? { data, error }
              : { data: resource.data ?? null, error: resource.error ?? null }),
          };
        },
      };
    },
  }));
  return { client: { from } as unknown as SupabaseClient, from, selects, eq };
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
      source: 'creation',
      format: 'media',
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
      resource: { access: 'none', priceTokens: 0, status: null },
    });
    // A text post has no creation behind it and says what it is.
    expect(toAgentPostView(row({ generation_id: null, post_format: 'text', category: 'text' }), OWNER)).toMatchObject({ generationId: null, source: 'text', format: 'text', category: 'text' });
    expect(toAgentPostView(row({ post_format: undefined }), OWNER).format).toBeNull();
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

  it('says what a post was made from: a creation, one deleted since included, files from elsewhere, or text', () => {
    expect(agentPostSource(row())).toBe('creation');
    expect(agentPostSource(row({ generation_id: null, source_kind: 'external', post_format: 'media' }))).toBe('upload');
    expect(agentPostSource(row({ generation_id: null, source_kind: 'external', post_format: 'mixed' }))).toBe('upload');
    expect(agentPostSource(row({ generation_id: null, source_kind: 'manual', post_format: 'text' }))).toBe('text');
    // The creation was deleted: the database keeps its id on the post, and the post is still a
    // creation's, not "uploaded media" (PR #751's review).
    expect(agentPostSource(row({ generation_id: null, deleted_generation_id: '55555555-5555-4555-8555-555555555555', post_format: 'media' }))).toBe('creation');
    expect(agentPostSource(row({ generation_id: null, source_kind: 'magicbooklet', post_format: 'media' }))).toBe('creation');
    expect(toAgentPostView(row({ generation_id: null, deleted_generation_id: '55555555-5555-4555-8555-555555555555' }), OWNER)).toMatchObject({ generationId: null, source: 'creation' });
  });

  it('counts the media a post holds, and says when it could not', async () => {
    const counting = (answer: { count: number | null; error: unknown }) => {
      const eq = vi.fn(async () => answer);
      const select = vi.fn(() => ({ eq }));
      const from = vi.fn(() => ({ select }));
      return { client: { from } as unknown as SupabaseClient, from, select, eq };
    };
    const two = counting({ count: 2, error: null });
    expect(await countPostMediaForAgent(two.client, POST_ID)).toBe(2);
    expect(two.from).toHaveBeenCalledWith('post_media');
    // A count alone: no row of the post's media is read.
    expect(two.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(two.eq).toHaveBeenCalledWith('post_id', POST_ID);
    expect(await countPostMediaForAgent(counting({ count: 0, error: null }).client, POST_ID)).toBe(0);
    expect(await countPostMediaForAgent(counting({ count: null, error: { message: 'down' } }).client, POST_ID)).toBeNull();
    expect(await countPostMediaForAgent(counting({ count: null, error: null }).client, POST_ID)).toBeNull();
  });

  it('says three things of a post\'s resource: its access, its price in tokens and whether it is on offer', () => {
    expect(toAgentPostResource(bundleRow(), true)).toEqual({ access: 'paid', priceTokens: 250, status: 'published' });
    expect(toAgentPostResource(bundleRow({ access_mode: 'free', price_usd_cents: 0 }), true)).toEqual({ access: 'free', priceTokens: 0, status: 'published' });
    // A free resource has no price, whatever the row's column holds.
    expect(toAgentPostResource(bundleRow({ access_mode: 'free', price_usd_cents: 250 }), true)).toMatchObject({ access: 'free', priceTokens: 0 });
    // Held as a draft while its post is not public: the owner is told, nobody else.
    expect(toAgentPostResource(bundleRow({ status: 'draft' }), true)).toEqual({ access: 'paid', priceTokens: 250, status: 'draft' });
    expect(toAgentPostResource(bundleRow({ status: 'draft' }), false)).toEqual(AGENT_POST_NO_RESOURCE);
    expect(toAgentPostResource(bundleRow(), false)).toEqual({ access: 'paid', priceTokens: 250, status: 'published' });
    // No row, a resource the creator removed while people held it, and an access that is neither.
    expect(toAgentPostResource(null, true)).toEqual(AGENT_POST_NO_RESOURCE);
    expect(toAgentPostResource(undefined, true)).toEqual(AGENT_POST_NO_RESOURCE);
    expect(toAgentPostResource(bundleRow({ retired_at: '2026-11-10T08:00:00Z' }), true)).toEqual(AGENT_POST_NO_RESOURCE);
    expect(toAgentPostResource(bundleRow({ access_mode: 'none' }), true)).toEqual(AGENT_POST_NO_RESOURCE);
    expect(toAgentPostResource(bundleRow({ price_usd_cents: null }), true)).toMatchObject({ access: 'paid', priceTokens: 0 });
    expect(AGENT_POST_NO_RESOURCE).toEqual({ access: 'none', priceTokens: 0, status: null });
  });

  it('reads the resource as four columns of its row and nothing it holds', async () => {
    const paid = admin(row({ generation_id: null, post_format: 'text' }), null, { data: bundleRow() });
    expect(await readPostForAgent(paid.client, { postId: POST_ID, viewerUserId: OTHER })).toMatchObject({
      ok: true,
      post: { format: 'text', resource: { access: 'paid', priceTokens: 250, status: 'published' } },
    });
    expect(paid.from.mock.calls.map(([table]) => table)).toEqual(['posts', 'post_resource_bundles']);
    expect(paid.eq).toHaveBeenLastCalledWith('post_id', POST_ID);
    // The paywall is the bundle read in post-resource-bundles-server.ts, which this never calls:
    // no item, section, text, link, summary or preview is asked for here.
    expect(paid.selects.post_resource_bundles).toEqual(['access_mode, price_usd_cents, status, retired_at']);
    expect(paid.selects.posts?.[0]).not.toMatch(/resource|bundle|prompt/u);
    expect(Object.keys(paid.selects)).toEqual(['posts', 'post_resource_bundles']);

    const view = await readPostForAgent(paid.client, { postId: POST_ID, viewerUserId: OWNER });
    expect(view.ok && Object.keys(view.post.resource).sort()).toEqual(['access', 'priceTokens', 'status']);

    // An owner's draft is theirs to know; a post with no row carries none.
    const draft = admin(row({ visibility: 'private' }), null, { data: bundleRow({ status: 'draft' }) });
    expect(await readPostForAgent(draft.client, { postId: POST_ID, viewerUserId: OWNER })).toMatchObject({ ok: true, post: { resource: { access: 'paid', priceTokens: 250, status: 'draft' } } });
    expect(await readPostForAgent(admin(row()).client, { postId: POST_ID, viewerUserId: OWNER })).toMatchObject({ ok: true, post: { resource: AGENT_POST_NO_RESOURCE } });
  });

  it('reads nothing of the resource of a post the viewer may not see, and fails whole when the resource cannot be read', async () => {
    const hidden = admin(row({ visibility: 'private' }), null, { data: bundleRow() });
    expect(await readPostForAgent(hidden.client, { postId: POST_ID, viewerUserId: OTHER })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(hidden.from.mock.calls.map(([table]) => table)).toEqual(['posts']);

    const down = admin(row(), null, { error: { message: 'down' } });
    expect(await readPostForAgent(down.client, { postId: POST_ID, viewerUserId: OWNER })).toEqual({ ok: false, code: 'UNAVAILABLE' });

    // A caller that uses nothing of the resource (a delete) does not read it, so that read cannot fail it.
    const alone = admin(row(), null, { error: { message: 'down' } });
    expect(await readPostForAgent(alone.client, { postId: POST_ID, viewerUserId: OWNER, withResource: false }))
      .toMatchObject({ ok: true, post: { postId: POST_ID, isOwn: true, resource: AGENT_POST_NO_RESOURCE } });
    expect(alone.from.mock.calls.map(([table]) => table)).toEqual(['posts']);
  });
});
