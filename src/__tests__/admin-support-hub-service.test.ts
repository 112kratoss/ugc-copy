import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const createOwnerPostForRoute = vi.hoisted(() => vi.fn());
const archiveOwnerPostForRoute = vi.hoisted(() => vi.fn());
const restoreOwnerPostForRoute = vi.hoisted(() => vi.fn());
const updateOwnerPostForRoute = vi.hoisted(() => vi.fn());

vi.mock('@/lib/post-create-route-service', () => ({ createOwnerPostForRoute }));
vi.mock('@/lib/post-lifecycle-service', () => ({ archiveOwnerPostForRoute, restoreOwnerPostForRoute }));
vi.mock('@/lib/post-update-service', () => ({ updateOwnerPostForRoute }));

import {
  announceSupportUpdate,
  editSupportUpdate,
  isSupportUpdateAnnounce,
  publishSupportUpdate,
  runSupportUpdateBroadcast,
  setSupportUpdatePublished,
  shipRoadmapItem,
} from '@/lib/admin-support-hub-service';

const OFFICIAL = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const POST_ID = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const ITEM_ID = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';

type Row = Record<string, unknown> | null;

/**
 * A stand-in for supabase-js with scripted rpc answers, scripted single-row
 * reads per table and recorded table writes (an insert answers `insertError`).
 */
function fakeSupabase(
  rpcAnswers: Record<string, unknown[]>,
  { rows = {}, insertError = null }: { rows?: Record<string, Row>; insertError?: unknown } = {},
) {
  const writes: Array<{ table: string; op: string; values: unknown }> = [];
  const rpc = vi.fn(async (fn: string) => {
    const queue = rpcAnswers[fn] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { data: next ?? null, error: null };
  });
  const table = (name: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['select', 'eq', 'not', 'order', 'limit', 'in', 'neq']) builder[method] = chain;
    builder.insert = (values: unknown) => {
      writes.push({ table: name, op: 'insert', values });
      return Promise.resolve({ error: insertError });
    };
    builder.update = (values: unknown) => {
      writes.push({ table: name, op: 'update', values });
      return builder;
    };
    builder.maybeSingle = async () => ({ data: rows[name] ?? null, error: null });
    builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
    return builder;
  };
  return { client: { rpc, from: table } as unknown as SupabaseClient, rpc, writes };
}

const LIVE_UPDATE = {
  id: POST_ID,
  user_id: OFFICIAL,
  support_update_kind: 'announcement',
  comments_locked: false,
  archived_at: null,
  title: 'Folders are here',
  visibility: 'public',
  review_status: 'visible',
};

beforeEach(() => {
  createOwnerPostForRoute.mockReset();
  archiveOwnerPostForRoute.mockReset();
  restoreOwnerPostForRoute.mockReset();
  updateOwnerPostForRoute.mockReset();
});

describe('isSupportUpdateAnnounce', () => {
  it('reads quiet and alert only: there is no push', () => {
    expect(isSupportUpdateAnnounce('quiet')).toBe(true);
    expect(isSupportUpdateAnnounce('alert')).toBe(true);
    expect(isSupportUpdateAnnounce('alert_push')).toBe(false);
  });
});

describe('publishSupportUpdate', () => {
  it('posts as the official account through the composer, marks the post and records its broadcast', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: true, status: 201, body: { id: POST_ID, visibility: 'public' } });
    const { client, rpc, writes } = fakeSupabase({
      support_official_account_id: [OFFICIAL],
      set_support_update: [{ status: 'set' }],
    });

    const result = await publishSupportUpdate({
      adminSupabase: client,
      kind: 'shipped',
      title: '  Folders are here  ',
      body: 'Group your creations into folders.',
      commentsLocked: false,
      announce: 'alert',
      postId: POST_ID,
    });

    expect(result).toEqual({ ok: true, value: { postId: POST_ID, announced: true } });
    const call = createOwnerPostForRoute.mock.calls[0]?.[0];
    expect(call.ownerUserId).toBe(OFFICIAL);
    expect(call.createPostId()).toBe(POST_ID);
    const form: FormData = await call.readFormData();
    expect(form.get('title')).toBe('Folders are here');
    expect(form.get('postFormat')).toBe('text');
    expect(form.get('visibility')).toBe('public');
    expect(rpc).toHaveBeenCalledWith('set_support_update', { p_post_id: POST_ID, p_kind: 'shipped', p_comments_locked: false });
    expect(writes).toEqual([{
      table: 'support_update_broadcasts',
      op: 'insert',
      values: { post_id: POST_ID, title: 'New on Magicbooklet', body: 'Folders are here' },
    }]);
  });

  it('records no broadcast for a quiet update', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: true, status: 201, body: { id: POST_ID } });
    const { client, writes } = fakeSupabase({ support_official_account_id: [OFFICIAL], set_support_update: [{ status: 'set' }] });

    const result = await publishSupportUpdate({
      adminSupabase: client, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: true, announce: 'quiet', postId: POST_ID,
    });

    expect(result).toEqual({ ok: true, value: { postId: POST_ID, announced: false } });
    expect(writes).toEqual([]);
  });

  it('answers a live update unannounced, never an error, when its broadcast cannot be recorded', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: true, status: 201, body: { id: POST_ID } });
    const { client } = fakeSupabase(
      { support_official_account_id: [OFFICIAL], set_support_update: [{ status: 'set' }] },
      { insertError: { code: '08006', message: 'connection lost' } },
    );

    const result = await publishSupportUpdate({
      adminSupabase: client, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'alert', postId: POST_ID,
    });

    // An error here would have the operator publish it again: a second update.
    expect(result).toEqual({ ok: true, value: { postId: POST_ID, announced: false } });
  });

  it('refuses without the official account, a kind, or words, before posting anything', async () => {
    expect(await publishSupportUpdate({ adminSupabase: fakeSupabase({}).client, postId: 'not-an-id', kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 400 });
    const none = fakeSupabase({ support_official_account_id: [null] });
    expect(await publishSupportUpdate({ adminSupabase: none.client, postId: POST_ID, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 409 });
    const ready = fakeSupabase({ support_official_account_id: [OFFICIAL] });
    expect(await publishSupportUpdate({ adminSupabase: ready.client, postId: POST_ID, kind: 'news', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await publishSupportUpdate({ adminSupabase: ready.client, postId: POST_ID, kind: 'announcement', title: ' ', body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 400, error: 'Give the update a title.' });
    expect(await publishSupportUpdate({ adminSupabase: ready.client, postId: POST_ID, kind: 'announcement', title: 'x'.repeat(101), body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 400, error: 'Keep the title to 100 characters.' });
    expect(await publishSupportUpdate({ adminSupabase: ready.client, postId: POST_ID, kind: 'announcement', title: 'Hi', body: 'x'.repeat(2001), commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 400, error: 'Keep the update to 2,000 characters.' });
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('answers a try that already went through as it was, and posts nothing twice', async () => {
    const { client, rpc, writes } = fakeSupabase(
      { support_official_account_id: [OFFICIAL] },
      { rows: { posts: { user_id: OFFICIAL, support_update_kind: 'announcement', archived_at: null, tombstoned_at: null } } },
    );

    const result = await publishSupportUpdate({
      adminSupabase: client, postId: POST_ID, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'alert',
    });

    expect(result).toEqual({ ok: true, value: { postId: POST_ID, announced: true } });
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('set_support_update', expect.anything());
    expect(writes).toEqual([{ table: 'support_update_broadcasts', op: 'insert', values: { post_id: POST_ID, title: 'News from Magicbooklet', body: 'Hi' } }]);
  });

  it('counts a broadcast recorded by the earlier try as announced', async () => {
    const { client } = fakeSupabase(
      { support_official_account_id: [OFFICIAL] },
      {
        rows: { posts: { user_id: OFFICIAL, support_update_kind: 'announcement', archived_at: null, tombstoned_at: null } },
        insertError: { code: '23505', message: 'duplicate key' },
      },
    );
    expect(await publishSupportUpdate({
      adminSupabase: client, postId: POST_ID, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'alert',
    })).toEqual({ ok: true, value: { postId: POST_ID, announced: true } });
  });

  it('finishes a try the composer left as a private draft, with the words as they are now', async () => {
    updateOwnerPostForRoute.mockResolvedValue({ ok: true, body: { success: true, postId: POST_ID } });
    const { client, rpc } = fakeSupabase(
      { support_official_account_id: [OFFICIAL], set_support_update: [{ status: 'set' }] },
      { rows: { posts: { user_id: OFFICIAL, support_update_kind: null, archived_at: null, tombstoned_at: null } } },
    );

    const result = await publishSupportUpdate({
      adminSupabase: client, postId: POST_ID, kind: 'shipped', title: 'Now', body: 'Words', commentsLocked: true, announce: 'quiet',
    });

    expect(result).toEqual({ ok: true, value: { postId: POST_ID, announced: false } });
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(updateOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase: client,
      ownerUserId: OFFICIAL,
      postId: POST_ID,
      body: { title: 'Now', body: 'Words', visibility: 'public' },
    });
    expect(rpc).toHaveBeenCalledWith('set_support_update', { p_post_id: POST_ID, p_kind: 'shipped', p_comments_locked: true });
  });

  it('starts over after a try that was taken down', async () => {
    const { client } = fakeSupabase(
      { support_official_account_id: [OFFICIAL] },
      { rows: { posts: { user_id: OFFICIAL, support_update_kind: null, archived_at: '2026-11-27T00:00:00Z', tombstoned_at: null } } },
    );
    expect(await publishSupportUpdate({
      adminSupabase: client, postId: POST_ID, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet',
    })).toMatchObject({ ok: false, status: 409, code: 'DRAFT_TAKEN_DOWN' });
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('refuses a post id another account holds', async () => {
    const { client } = fakeSupabase(
      { support_official_account_id: [OFFICIAL] },
      { rows: { posts: { user_id: 'someone-else', support_update_kind: null, archived_at: null, tombstoned_at: null } } },
    );
    expect(await publishSupportUpdate({
      adminSupabase: client, postId: POST_ID, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet',
    })).toMatchObject({ ok: false, status: 409 });
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(updateOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('passes on the composer\'s refusal', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: false, status: 400, body: { error: 'Add a title that says what this is.' } });
    const { client } = fakeSupabase({ support_official_account_id: [OFFICIAL] });
    expect(await publishSupportUpdate({ adminSupabase: client, postId: POST_ID, kind: 'announcement', title: 'Demo', body: 'x', commentsLocked: false, announce: 'quiet' }))
      .toEqual({ ok: false, status: 400, error: 'Add a title that says what this is.' });
  });

  it('takes the post down again through the owner\'s archive when it cannot be marked', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: true, status: 201, body: { id: POST_ID } });
    archiveOwnerPostForRoute.mockResolvedValue({ ok: true, body: { success: true, archived: true } });
    const { client, writes } = fakeSupabase({ support_official_account_id: [OFFICIAL], set_support_update: [{ status: 'not_public' }] });

    const result = await publishSupportUpdate({
      adminSupabase: client, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'alert', postId: POST_ID,
    });

    // The console starts a new post for the next try.
    expect(result).toMatchObject({ ok: false, status: 409, code: 'DRAFT_TAKEN_DOWN' });
    expect(archiveOwnerPostForRoute).toHaveBeenCalledWith({ adminSupabase: client, ownerUserId: OFFICIAL, postId: POST_ID });
    expect(writes).toEqual([]);
  });

  it('says so when the stray post could not be taken down either', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: true, status: 201, body: { id: POST_ID } });
    archiveOwnerPostForRoute.mockResolvedValue({ ok: false, status: 500, body: { error: 'Failed to archive post.' } });
    const { client } = fakeSupabase({ support_official_account_id: [OFFICIAL], set_support_update: [{ status: 'not_public' }] });

    const result = await publishSupportUpdate({
      adminSupabase: client, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet', postId: POST_ID,
    });

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect((result as { error: string }).error).toMatch(/taking it down failed/);
  });
});

describe('runSupportUpdateBroadcast', () => {
  it('sends batches until done', async () => {
    const { client, rpc } = fakeSupabase({
      support_update_alert_batch: [
        { status: 'continuing', sentCount: 2, told: 2 },
        { status: 'finished', sentCount: 3, told: 1 },
      ],
    });

    const progress = await runSupportUpdateBroadcast({ adminSupabase: client, postId: POST_ID, batchSize: 2 });

    expect(progress).toEqual({ status: 'finished', sentCount: 3 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('support_update_alert_batch', { p_post_id: POST_ID, p_limit: 2 });
  });

  it('stops at a pause (the update is down) and at its time budget', async () => {
    const paused = fakeSupabase({ support_update_alert_batch: [{ status: 'paused', sentCount: 4, told: 0 }] });
    expect(await runSupportUpdateBroadcast({ adminSupabase: paused.client, postId: POST_ID }))
      .toEqual({ status: 'paused', sentCount: 4 });
    expect(paused.rpc).toHaveBeenCalledTimes(1);

    let clock = 0;
    const { client, rpc } = fakeSupabase({
      support_update_alert_batch: [{ status: 'continuing', sentCount: 1, told: 1 }],
    });
    const progress = await runSupportUpdateBroadcast({
      adminSupabase: client,
      postId: POST_ID,
      timeBudgetMs: 25,
      now: () => (clock += 10),
    });
    expect(progress.status).toBe('continuing');
    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('editSupportUpdate', () => {
  it('saves through the owner\'s own edit, which refreshes the cached cards and page', async () => {
    updateOwnerPostForRoute.mockResolvedValue({ ok: true, body: { success: true, postId: POST_ID } });
    const { client, writes } = fakeSupabase({}, { rows: { posts: LIVE_UPDATE } });

    const result = await editSupportUpdate({ adminSupabase: client, postId: POST_ID, title: ' New words ', body: ' The body ' });

    expect(result).toEqual({ ok: true, value: null });
    expect(updateOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase: client,
      ownerUserId: OFFICIAL,
      postId: POST_ID,
      body: { title: 'New words', body: 'The body' },
    });
    expect(writes).toEqual([]);
  });

  it('passes on the edit\'s refusal and its rate limit', async () => {
    const { client } = fakeSupabase({}, { rows: { posts: LIVE_UPDATE } });
    updateOwnerPostForRoute.mockResolvedValueOnce({
      ok: false, status: 409, body: { error: 'This post is locked while a moderation decision is in effect.' },
    });
    expect(await editSupportUpdate({ adminSupabase: client, postId: POST_ID, title: 'A', body: 'B' }))
      .toEqual({ ok: false, status: 409, error: 'This post is locked while a moderation decision is in effect.' });
    updateOwnerPostForRoute.mockResolvedValueOnce({ ok: false, status: 429, rateLimitError: new Error('slow'), body: { error: 'slow' } });
    expect(await editSupportUpdate({ adminSupabase: client, postId: POST_ID, title: 'A', body: 'B' }))
      .toMatchObject({ ok: false, status: 429 });
  });

  it('refuses words past a post\'s limits, and an update that is gone', async () => {
    const { client } = fakeSupabase({}, { rows: { posts: LIVE_UPDATE } });
    expect(await editSupportUpdate({ adminSupabase: client, postId: POST_ID, title: 'x'.repeat(101), body: 'B' }))
      .toMatchObject({ ok: false, status: 400 });
    const gone = fakeSupabase({});
    expect(await editSupportUpdate({ adminSupabase: gone.client, postId: POST_ID, title: 'A', body: 'B' }))
      .toMatchObject({ ok: false, status: 404 });
    expect(updateOwnerPostForRoute).not.toHaveBeenCalled();
  });
});

describe('setSupportUpdatePublished', () => {
  it('takes an update down and puts it back through the owner\'s archive and restore', async () => {
    archiveOwnerPostForRoute.mockResolvedValue({ ok: true, body: { success: true, archived: true } });
    restoreOwnerPostForRoute.mockResolvedValue({ ok: true, body: { success: true, restored: true } });

    const live = fakeSupabase({}, { rows: { posts: LIVE_UPDATE } });
    expect(await setSupportUpdatePublished({ adminSupabase: live.client, postId: POST_ID, published: false }))
      .toEqual({ ok: true, value: null });
    expect(archiveOwnerPostForRoute).toHaveBeenCalledWith({ adminSupabase: live.client, ownerUserId: OFFICIAL, postId: POST_ID });

    const down = fakeSupabase({}, { rows: { posts: { ...LIVE_UPDATE, archived_at: '2026-11-27T00:00:00Z' } } });
    expect(await setSupportUpdatePublished({ adminSupabase: down.client, postId: POST_ID, published: true }))
      .toEqual({ ok: true, value: null });
    expect(restoreOwnerPostForRoute).toHaveBeenCalledWith({ adminSupabase: down.client, ownerUserId: OFFICIAL, postId: POST_ID });
    expect([...live.writes, ...down.writes]).toEqual([]);
  });

  it('does nothing for an update already in the state asked for', async () => {
    const live = fakeSupabase({}, { rows: { posts: LIVE_UPDATE } });
    expect(await setSupportUpdatePublished({ adminSupabase: live.client, postId: POST_ID, published: true }))
      .toEqual({ ok: true, value: null });
    expect(restoreOwnerPostForRoute).not.toHaveBeenCalled();
    expect(archiveOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('passes on a refusal: a deleted post, the rate limit', async () => {
    const down = fakeSupabase({}, { rows: { posts: { ...LIVE_UPDATE, archived_at: '2026-11-27T00:00:00Z' } } });
    restoreOwnerPostForRoute.mockResolvedValueOnce({
      ok: false, status: 409, body: { error: 'This post was deleted. Buyers keep their copy.', code: 'POST_DELETED' },
    });
    expect(await setSupportUpdatePublished({ adminSupabase: down.client, postId: POST_ID, published: true }))
      .toEqual({ ok: false, status: 409, error: 'This post was deleted. Buyers keep their copy.' });
    restoreOwnerPostForRoute.mockResolvedValueOnce({ ok: false, rateLimitError: new Error('slow') });
    expect(await setSupportUpdatePublished({ adminSupabase: down.client, postId: POST_ID, published: true }))
      .toMatchObject({ ok: false, status: 429 });
  });
});

describe('announceSupportUpdate', () => {
  it('records the broadcast of a live update', async () => {
    const { client, writes } = fakeSupabase({}, { rows: { posts: LIVE_UPDATE } });
    expect(await announceSupportUpdate({ adminSupabase: client, postId: POST_ID }))
      .toEqual({ ok: true, value: { postId: POST_ID } });
    expect(writes).toEqual([{
      table: 'support_update_broadcasts',
      op: 'insert',
      values: { post_id: POST_ID, title: 'News from Magicbooklet', body: 'Folders are here' },
    }]);
  });

  it('answers a second announce (a double click) with 409, not an error', async () => {
    const { client } = fakeSupabase({}, { rows: { posts: LIVE_UPDATE }, insertError: { code: '23505', message: 'duplicate key' } });
    expect(await announceSupportUpdate({ adminSupabase: client, postId: POST_ID }))
      .toMatchObject({ ok: false, status: 409 });
  });

  it('refuses an update that is not live', async () => {
    const { client, writes } = fakeSupabase({}, { rows: { posts: { ...LIVE_UPDATE, archived_at: '2026-11-27T00:00:00Z' } } });
    expect(await announceSupportUpdate({ adminSupabase: client, postId: POST_ID }))
      .toMatchObject({ ok: false, status: 409 });
    expect(writes).toEqual([]);
  });
});

describe('shipRoadmapItem', () => {
  it('ships the item with its update and says how many were told in the app', async () => {
    const { client, rpc } = fakeSupabase(
      { ship_support_roadmap_item: [{ status: 'shipped', told: 2 }] },
      { rows: { support_roadmap_items: { title: 'Folders for creations' } } },
    );

    const result = await shipRoadmapItem({ adminSupabase: client, itemId: ITEM_ID, updatePostId: POST_ID });

    expect(result).toEqual({ ok: true, value: { told: 2 } });
    expect(rpc).toHaveBeenCalledWith('ship_support_roadmap_item', {
      p_item_id: ITEM_ID,
      p_update_post_id: POST_ID,
      p_title: 'You asked, it’s live',
      p_body: 'Folders for creations is here. Take a look.',
    });
  });

  it('refuses an update that is not one', async () => {
    const { client } = fakeSupabase(
      { ship_support_roadmap_item: [{ status: 'update_not_found' }] },
      { rows: { support_roadmap_items: { title: 'Folders for creations' } } },
    );
    expect(await shipRoadmapItem({ adminSupabase: client, itemId: ITEM_ID, updatePostId: POST_ID }))
      .toMatchObject({ ok: false, status: 409 });
  });
});
