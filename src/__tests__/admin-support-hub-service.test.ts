import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const createOwnerPostForRoute = vi.hoisted(() => vi.fn());
const pushStoredMobileNotifications = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/post-create-route-service', () => ({ createOwnerPostForRoute }));
vi.mock('@/lib/mobile-notifications', () => ({ pushStoredMobileNotifications }));

import {
  publishSupportUpdate,
  runSupportUpdateBroadcast,
  shipRoadmapItem,
} from '@/lib/admin-support-hub-service';

const OFFICIAL = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const POST_ID = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const ITEM_ID = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';

/** A stand-in for supabase-js with scripted rpc answers and recorded table writes. */
function fakeSupabase(rpcAnswers: Record<string, unknown[]>) {
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
      return Promise.resolve({ error: null });
    };
    builder.update = (values: unknown) => {
      writes.push({ table: name, op: 'update', values });
      return builder;
    };
    builder.maybeSingle = async () => ({ data: name === 'support_roadmap_items' ? { title: 'Folders for creations' } : null, error: null });
    builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
    return builder;
  };
  return { client: { rpc, from: table } as unknown as SupabaseClient, rpc, writes };
}

beforeEach(() => {
  createOwnerPostForRoute.mockReset();
  pushStoredMobileNotifications.mockClear();
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
      announce: 'alert_push',
      createPostId: () => POST_ID,
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
      values: { post_id: POST_ID, push: true, title: 'New on Magicbooklet', body: 'Folders are here' },
    }]);
  });

  it('records no broadcast for a quiet update', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: true, status: 201, body: { id: POST_ID } });
    const { client, writes } = fakeSupabase({ support_official_account_id: [OFFICIAL], set_support_update: [{ status: 'set' }] });

    const result = await publishSupportUpdate({
      adminSupabase: client, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: true, announce: 'quiet', createPostId: () => POST_ID,
    });

    expect(result).toEqual({ ok: true, value: { postId: POST_ID, announced: false } });
    expect(writes).toEqual([]);
  });

  it('refuses without the official account, a kind, or words, before posting anything', async () => {
    const none = fakeSupabase({ support_official_account_id: [null] });
    expect(await publishSupportUpdate({ adminSupabase: none.client, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 409 });
    const ready = fakeSupabase({ support_official_account_id: [OFFICIAL] });
    expect(await publishSupportUpdate({ adminSupabase: ready.client, kind: 'news', title: 'Hi', body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 400 });
    expect(await publishSupportUpdate({ adminSupabase: ready.client, kind: 'announcement', title: ' ', body: 'There', commentsLocked: false, announce: 'quiet' }))
      .toMatchObject({ ok: false, status: 400, error: 'Give the update a title.' });
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('passes on the composer\'s refusal', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: false, status: 400, body: { error: 'Add a title that says what this is.' } });
    const { client } = fakeSupabase({ support_official_account_id: [OFFICIAL] });
    expect(await publishSupportUpdate({ adminSupabase: client, kind: 'announcement', title: 'Demo', body: 'x', commentsLocked: false, announce: 'quiet' }))
      .toEqual({ ok: false, status: 400, error: 'Add a title that says what this is.' });
  });

  it('takes the post down again when it cannot be marked', async () => {
    createOwnerPostForRoute.mockResolvedValue({ ok: true, status: 201, body: { id: POST_ID } });
    const { client, writes } = fakeSupabase({ support_official_account_id: [OFFICIAL], set_support_update: [{ status: 'not_public' }] });

    const result = await publishSupportUpdate({
      adminSupabase: client, kind: 'announcement', title: 'Hi', body: 'There', commentsLocked: false, announce: 'alert', createPostId: () => POST_ID,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(writes[0]).toMatchObject({ table: 'posts', op: 'update' });
    expect(writes.some((write) => write.table === 'support_update_broadcasts')).toBe(false);
  });
});

describe('runSupportUpdateBroadcast', () => {
  it('sends batches until done, pushing each batch\'s alerts when the broadcast pushes', async () => {
    const { client, rpc } = fakeSupabase({
      support_update_alert_batch: [
        { status: 'continuing', push: true, sentCount: 2, written: [{ id: 'n1', userId: 'u1' }, { id: 'n2', userId: 'u2' }] },
        { status: 'finished', push: true, sentCount: 3, written: [{ id: 'n3', userId: 'u3' }] },
      ],
    });

    const progress = await runSupportUpdateBroadcast({ adminSupabase: client, postId: POST_ID, batchSize: 2 });

    expect(progress).toEqual({ status: 'finished', sentCount: 3 });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('support_update_alert_batch', { p_post_id: POST_ID, p_limit: 2 });
    expect(pushStoredMobileNotifications).toHaveBeenNthCalledWith(1, client, [{ id: 'n1', userId: 'u1' }, { id: 'n2', userId: 'u2' }]);
    expect(pushStoredMobileNotifications).toHaveBeenNthCalledWith(2, client, [{ id: 'n3', userId: 'u3' }]);
  });

  it('pushes nothing for an alert-only broadcast, and stops at its time budget', async () => {
    let clock = 0;
    const { client, rpc } = fakeSupabase({
      support_update_alert_batch: [{ status: 'continuing', push: false, sentCount: 1, written: [{ id: 'n1', userId: 'u1' }] }],
    });

    const progress = await runSupportUpdateBroadcast({
      adminSupabase: client,
      postId: POST_ID,
      timeBudgetMs: 25,
      now: () => (clock += 10),
    });

    expect(progress.status).toBe('continuing');
    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(pushStoredMobileNotifications).not.toHaveBeenCalled();
  });
});

describe('shipRoadmapItem', () => {
  it('ships the item with its update and pushes the alerts of everyone who reacted', async () => {
    const { client, rpc } = fakeSupabase({
      ship_support_roadmap_item: [{ status: 'shipped', written: [{ id: 'n1', userId: 'u1' }] }],
    });

    const result = await shipRoadmapItem({ adminSupabase: client, itemId: ITEM_ID, updatePostId: POST_ID });

    expect(result).toEqual({ ok: true, value: { told: 1 } });
    expect(rpc).toHaveBeenCalledWith('ship_support_roadmap_item', {
      p_item_id: ITEM_ID,
      p_update_post_id: POST_ID,
      p_title: 'You asked, it’s live',
      p_body: 'Folders for creations is here. Take a look.',
    });
    expect(pushStoredMobileNotifications).toHaveBeenCalledWith(client, [{ id: 'n1', userId: 'u1' }]);
  });

  it('refuses an update that is not one', async () => {
    const { client } = fakeSupabase({ ship_support_roadmap_item: [{ status: 'update_not_found' }] });
    expect(await shipRoadmapItem({ adminSupabase: client, itemId: ITEM_ID, updatePostId: POST_ID }))
      .toMatchObject({ ok: false, status: 409 });
  });
});
