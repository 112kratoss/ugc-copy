import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { hasAnswered } from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { sendDeferrableNotification } from '@/lib/deferrable-notification';
import {
  notifyCreatorFollowed,
  notifyGenerationStatus,
  notifyPostSocialActivity,
} from '@/lib/mobile-notifications';

describe('sendDeferrableNotification', () => {
  it('sends the notification before returning when the caller has nowhere to run it afterwards', async () => {
    let finishNotifying = () => {};
    const notify = vi.fn(() => new Promise<null>((resolve) => {
      finishNotifying = () => resolve(null);
    }));

    const sending = sendDeferrableNotification(undefined, notify);

    expect(await hasAnswered(sending)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    finishNotifying();
    await expect(sending).resolves.toBeUndefined();
  });

  it('hands the notification to the scheduler without starting it when the caller can run work after the response', async () => {
    const notify = vi.fn(() => new Promise<null>(() => {}));
    const deferred: Array<() => Promise<unknown>> = [];

    const sending = sendDeferrableNotification((task) => { deferred.push(task); }, notify);

    // A push that never finishes holds nothing back.
    expect(await hasAnswered(sending)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(deferred).toEqual([notify]);
  });

  it('sends the notification in front of the answer when the scheduler will not take it', async () => {
    const notify = vi.fn(async () => null);
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await expect(sendDeferrableNotification(() => {
        throw new Error('`after` was called outside a request scope.');
      }, notify)).resolves.toBeUndefined();
    } finally {
      restoreLogSink();
    }

    expect(notify).toHaveBeenCalledTimes(1);
    expect(logged).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'mobile_notification_deferral_failed',
        errorMessage: '`after` was called outside a request scope.',
      }),
    ]);
  });
});

describe('notifiers sent behind an answer', () => {
  // Sending a notifier after the response moves it out from under the request:
  // an error it threw would no longer fail the request, it would only reach
  // the log. That hides nothing as long as none of them can reject, which is
  // what this pins for each notifier the follow, save and share paths queue,
  // and for the one a generation status poll queues.
  const generationNotifiers: Array<[string, (client: SupabaseClient) => Promise<unknown>]> = (
    ['failed', 'succeeded'] as const
  ).map((status) => [
    `a generation that ${status}`,
    (client) => notifyGenerationStatus(client, {
      id: 'generation-1',
      user_id: 'user-1',
      category: 'video',
      model: 'kling-3.0-video',
      template_run_id: null,
    }, status),
  ]);
  const followNotifier: [string, (client: SupabaseClient) => Promise<unknown>] = [
    'a follow',
    (client) => notifyCreatorFollowed(client, {
      followerUserId: 'follower-1',
      followingUserId: 'creator-1',
      followerUsername: 'athul',
    }),
  ];
  // A save or a share is grouped: its first step is one database call, not a
  // table read.
  const groupedNotifiers: Array<[string, (client: SupabaseClient) => Promise<unknown>]> = [
    ['a save', (client) => notifyPostSocialActivity(client, {
      type: 'post_saved',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    })],
    ['a share', (client) => notifyPostSocialActivity(client, {
      type: 'post_shared',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    })],
  ];

  async function logsOf(run: () => Promise<void>) {
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await run();
    } finally {
      restoreLogSink();
    }

    return logged.map((record) => record.msg);
  }

  it.each([followNotifier, ...groupedNotifiers, ...generationNotifiers])(
    'the notifier for %s logs a failure instead of rejecting when the database is unavailable',
    async (_action, notify) => {
      const unavailable = {
        from: () => {
          throw new Error('database unavailable');
        },
        rpc: () => {
          throw new Error('database unavailable');
        },
      } as unknown as SupabaseClient;

      const logged = await logsOf(async () => {
        await expect(notify(unavailable)).resolves.toBeNull();
      });

      expect(logged).toEqual(['failed_to_create_mobile_notification']);
    },
  );

  it.each(groupedNotifiers)(
    'the notifier for %s logs a failure instead of rejecting when its grouped write is refused',
    async (_action, notify) => {
      const refusing = {
        from: () => {
          throw new Error('Unexpected table read');
        },
        rpc: async () => ({ data: null, error: { message: 'permission denied' } }),
      } as unknown as SupabaseClient;

      const logged = await logsOf(async () => {
        await expect(notify(refusing)).resolves.toBeNull();
      });

      expect(logged).toEqual(['failed_to_create_mobile_notification']);
    },
  );
});
