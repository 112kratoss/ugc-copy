import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const notify = vi.hoisted(() => vi.fn());
const recordFeedEvent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mobile-notifications', async (importOriginal) => ({
  createMobileNotification: notify,
  // The real builder, so the link the alert carries is the one the server writes.
  buildMobileNotificationDeepLink:
    (await importOriginal<typeof import('@/lib/mobile-notifications')>()).buildMobileNotificationDeepLink,
}));
vi.mock('@/lib/showcase-feed-events-service', () => ({
  recordAuthoritativeFeedEvent: recordFeedEvent,
}));
import { hasAnswered } from '@/__tests__/fixtures/mobile-notification-history';
import { notifyCompletedRemix } from '@/lib/completed-remix-notification';
import { settleGenerationSucceeded } from '@/lib/generation-settlement';

/** `linked`: the guest identities linked to each account (`profiles.merged_into_user_id`). */
function client(remix: unknown, linked: Record<string, string[]> = {}) {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: remix, error: null }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const linkedGuests = (accountId: string) => {
    const read = {
      select: () => read,
      eq: (column: string, value: string) => {
        if (column !== 'merged_into_user_id') throw new Error(`Unexpected filter ${column}`);
        accountId = value;
        return read;
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: (linked[accountId] ?? []).map((id) => ({ id })),
        error: null,
      }).then(resolve),
    };
    return read;
  };
  const from = vi.fn((table: string) => (table === 'profiles' ? linkedGuests('') : query));
  return { db: { from } as unknown as SupabaseClient, from, query };
}

const recorded = { generation_id: 'output', post_id: 'post', actor_user_id: 'reader', posts: { user_id: 'creator' } };

describe('completed remix notifications', () => {
  beforeEach(() => {
    notify.mockReset().mockResolvedValue(null);
    recordFeedEvent.mockReset().mockResolvedValue({ status: 'recorded', deliveryId: null });
  });

  it('records the finished remix as the remixer\'s remix_complete on the original, once per output', async () => {
    const { db } = client({ ...recorded, completed_at: '2026-10-01T09:00:00.000Z' });
    await notifyCompletedRemix(db, 'prediction');
    expect(recordFeedEvent).toHaveBeenCalledTimes(1);
    expect(recordFeedEvent).toHaveBeenCalledWith(db, {
      eventType: 'remix_complete',
      viewerUserId: 'reader',
      postId: 'post',
      // A retried settlement carries the same output, so it is a duplicate.
      actionKey: 'output',
      occurredAt: '2026-10-01T09:00:00.000Z',
      // Credited to the delivery the remix was started from.
      inferDeliveryFrom: { eventTypes: ['remix_start'], withinHours: 48 },
    });
  });

  it.each([
    [null],
    [{ ...recorded, actor_user_id: 'creator' }],
    [{ ...recorded, posts: null }],
  ])('records no feed event without an eligible completion, or for a self-remix', async (remix) => {
    const { db } = client(remix);
    await notifyCompletedRemix(db, 'prediction');
    expect(recordFeedEvent).not.toHaveBeenCalled();
  });

  it('still notifies, and never fails settlement, when the feed event fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { db } = client(recorded);
    recordFeedEvent.mockRejectedValue(new Error('feed events unavailable'));
    await expect(notifyCompletedRemix(db, 'prediction')).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('notifies from recorded completion with a stable output dedupe key', async () => {
    const { db, query } = client(recorded);
    await notifyCompletedRemix(db, 'prediction');
    expect(query.eq).toHaveBeenCalledWith('notification_eligible', true);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'creator', actorUserId: 'reader', dedupeKey: 'completed-remix:output', body: 'They finished a new creation from it.' }));
  });

  it('opens the remixed post page, as every post alert does', async () => {
    const { db } = client(recorded);
    await notifyCompletedRemix(db, 'prediction');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      type: 'post_remixed',
      deepLink: '/showcase/post',
      objectId: 'post',
    }));
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

  // A creation made as a guest is posted by the account the guest was linked
  // to, so a run the guest started from it is the account's own remix.
  it('treats a remix by a guest linked to the post owner as a self-remix', async () => {
    const { db } = client({ ...recorded, actor_user_id: 'guest-of-creator' }, { creator: ['guest-of-creator'] });
    await notifyCompletedRemix(db, 'prediction');
    expect(notify).not.toHaveBeenCalled();
    expect(recordFeedEvent).not.toHaveBeenCalled();
  });

  it("still notifies for a remix by another account's guest", async () => {
    const { db } = client({ ...recorded, actor_user_id: 'guest-of-reader' }, { reader: ['guest-of-reader'] });
    await notifyCompletedRemix(db, 'prediction');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'creator', actorUserId: 'guest-of-reader' }));
  });

  it('never turns successful settlement into failure when notification delivery fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { db } = client(recorded);
    notify.mockRejectedValue(new Error('unavailable'));
    await expect(notifyCompletedRemix(db, 'prediction')).resolves.toBeUndefined();
    log.mockRestore();
  });

  // Only the output-import job settles a success, from the cron or from the
  // webhook's own after() window. Neither has a person's answer to send the
  // notification behind, so it stays inside the settlement.
  it('is sent before a successful settlement returns', async () => {
    let finishNotifying = () => {};
    notify.mockImplementationOnce(() => new Promise<null>((resolve) => {
      finishNotifying = () => resolve(null);
    }));
    const { db } = client(recorded);
    const settlementClient = {
      from: db.from,
      rpc: vi.fn(async () => ({ data: { status: 'succeeded' }, error: null })),
    } as unknown as SupabaseClient;

    const settlement = settleGenerationSucceeded(settlementClient, { predictionId: 'prediction' });

    expect(await hasAnswered(settlement)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    finishNotifying();
    await expect(settlement).resolves.toBe('succeeded');
  });
});
