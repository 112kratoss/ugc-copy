import { describe, expect, it, vi } from 'vitest';

import { hasAnswered } from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { sendDeferrableNotification } from '@/lib/deferrable-notification';

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
