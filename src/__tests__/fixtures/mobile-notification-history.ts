import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Notification history the real notifier can run against.
 *
 * It answers the two tables `createMobileNotification` touches before it
 * pushes, records what was looked up and written, and can hold every
 * notification at its first step. Holding is how a test stands in for a push
 * fan-out that has not finished: push is switched off in the preferences it
 * returns, so nothing here reaches the network.
 */
export function createMobileNotificationHistory() {
  const started: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let held: Promise<void> | null = null;
  let releaseHeld = () => {};

  return {
    /** Dedupe keys, in the order the notifier began work on them. */
    started,
    /** Notification rows, in the order they were written. */
    sent,
    /** Every notification from here on waits at its first step until `release()`. */
    hold() {
      held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
    },
    release() {
      releaseHeld();
    },
    handles(table: string) {
      return table === 'mobile_notifications' || table === 'mobile_notification_preferences';
    },
    from(table: string) {
      if (table === 'mobile_notifications') {
        return {
          select() {
            const query = {
              eq(column: string, value: unknown) {
                if (column === 'dedupe_key') started.push(String(value));
                return query;
              },
              async maybeSingle() {
                await held;
                return { data: null, error: null };
              },
            };
            return query;
          },
          insert(values: Record<string, unknown>) {
            sent.push(values);
            return {
              select() {
                return {
                  async single() {
                    return {
                      data: {
                        id: `notification-${sent.length}`,
                        ...values,
                        event_count: 1,
                        is_read: false,
                        created_at: '2026-10-01T00:00:00.000Z',
                        updated_at: '2026-10-01T00:00:00.000Z',
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'mobile_notification_preferences') {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return {
                      data: {
                        push_enabled: false,
                        generation_enabled: true,
                        commerce_enabled: true,
                        social_enabled: true,
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected notification table: ${table}`);
    },
  };
}

export type MobileNotificationHistory = ReturnType<typeof createMobileNotificationHistory>;

/** The same client, with its notification tables served by `history`. */
export function withMobileNotificationHistory(
  client: SupabaseClient,
  history: MobileNotificationHistory,
): SupabaseClient {
  return {
    from: (table: string) => (history.handles(table) ? history.from(table) : client.from(table)),
    rpc: (name: string, args?: Record<string, unknown>) => client.rpc(name, args),
  } as unknown as SupabaseClient;
}

/**
 * Lets everything that is ready to run finish, then says whether the promise
 * has settled. It returns as soon as the promise does; one still pending after
 * this many turns of the event loop is waiting on something a test is holding
 * open, not on work that simply had not run yet.
 */
export async function hasAnswered(promise: Promise<unknown>) {
  let answered = false;
  const markAnswered = () => {
    answered = true;
  };
  void promise.then(markAnswered, markAnswered);

  for (let turn = 0; turn < 20 && !answered; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return answered;
}
