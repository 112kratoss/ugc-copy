import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const notify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mobile-notifications', () => ({
  createMobileNotification: notify,
  buildMobileNotificationDeepLink: ({ postId }: { postId: string }) => `/post/${postId}`,
}));
import { notifyCompletedRemix } from '@/lib/completed-remix-notification';

function client(remix: unknown) {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: remix, error: null }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const from = vi.fn(() => query);
  return { db: { from } as unknown as SupabaseClient, from, query };
}

const recorded = { generation_id: 'output', post_id: 'post', actor_user_id: 'reader', posts: { user_id: 'creator' } };

describe('completed remix notifications', () => {
  beforeEach(() => { notify.mockReset().mockResolvedValue(null); });

  it('notifies from recorded completion with a stable output dedupe key', async () => {
    const { db, query } = client(recorded);
    await notifyCompletedRemix(db, 'prediction');
    expect(query.eq).toHaveBeenCalledWith('notification_eligible', true);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'creator', actorUserId: 'reader', dedupeKey: 'completed-remix:output', body: 'They finished a new creation from it.' }));
  });

  // This runs on the tail of every successful settlement, so the generation
  // with no lineage at all — the common case — must not pay for a second read.
  it('asks once, through the settled prediction', async () => {
    const { db, from, query } = client(null);
    await notifyCompletedRemix(db, 'prediction');
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('completed_post_remixes');
    expect(query.eq).toHaveBeenCalledWith('generations.prediction_id', 'prediction');
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [{ ...recorded, actor_user_id: 'creator' }],
    [{ ...recorded, posts: null }],
  ])('does not notify without eligible completion or for self-remixes', async (remix) => {
    const { db } = client(remix);
    await notifyCompletedRemix(db, 'prediction');
    expect(notify).not.toHaveBeenCalled();
  });

  it('never turns successful settlement into failure when notification delivery fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { db } = client(recorded);
    notify.mockRejectedValue(new Error('unavailable'));
    await expect(notifyCompletedRemix(db, 'prediction')).resolves.toBeUndefined();
    log.mockRestore();
  });
});
