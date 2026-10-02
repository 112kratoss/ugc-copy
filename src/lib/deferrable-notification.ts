import 'server-only';

import { logBackendError } from '@/lib/backend-logger';

/**
 * Runs a task once the caller has answered its request. A route with someone
 * waiting on its answer passes one, so a notification stops holding that
 * answer back.
 */
export type RunAfterResponse = (task: () => Promise<unknown>) => void;

/**
 * Once something is recorded, what is left is telling the other person: a
 * notification row, then a push to their devices through Expo, which can be
 * slow, retried, or refused. None of that changes the caller's answer, so a
 * caller with someone waiting on its answer passes a scheduler and the
 * notification goes out behind the answer. Without one it is sent before this
 * returns.
 *
 * Neither path can fail what is already recorded. Every notifier handed in
 * logs its own failures and never rejects, so sending it later hides no error;
 * and a scheduler that will not take the task only means the notification is
 * sent the slow way, in front of the answer.
 *
 * This queues one task. Next's after() starts everything it was handed at
 * once, so a caller with several notifications whose order matters has to
 * chain them itself.
 */
export async function sendDeferrableNotification(
  runAfterResponse: RunAfterResponse | undefined,
  notify: () => Promise<unknown>,
) {
  if (runAfterResponse) {
    try {
      runAfterResponse(notify);
      return;
    } catch (error) {
      logBackendError('mobile_notification_deferral_failed', { error });
    }
  }

  await notify();
}
