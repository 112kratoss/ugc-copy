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

/** The lookup `createMobileNotification` makes before it writes. */
type DedupeLookup = {
  eq(column: string, value: unknown): DedupeLookup;
  maybeSingle(): Promise<unknown>;
};

/**
 * `history`, with the unique index the real table keeps on
 * `(user_id, dedupe_key)`.
 *
 * On its own the history answers every lookup with "nothing yet", so two sends
 * of one key both go out. With this a lookup finds the notification an earlier
 * send wrote, and a second write of one that slipped past the lookup is
 * refused the way Postgres refuses it.
 */
export function withUniqueDedupeKeys(history: MobileNotificationHistory): MobileNotificationHistory {
  const written = (userId: unknown, dedupeKey: unknown) => {
    if (dedupeKey === null || dedupeKey === undefined) return null;
    const index = history.sent.findIndex(
      (row) => row.user_id === userId && row.dedupe_key === dedupeKey,
    );
    return index < 0 ? null : { id: `notification-${index + 1}`, ...history.sent[index] };
  };

  function notifications() {
    const table = history.from('mobile_notifications') as unknown as {
      select(): DedupeLookup;
      insert(values: Record<string, unknown>): unknown;
    };

    return {
      select() {
        const lookup = table.select();
        const filters: Record<string, unknown> = {};
        const query = {
          eq(column: string, value: unknown) {
            filters[column] = value;
            lookup.eq(column, value);
            return query;
          },
          async maybeSingle() {
            // Still waits while the history is held, then reads what has been
            // written by the time it is let go.
            await lookup.maybeSingle();
            return { data: written(filters.user_id, filters.dedupe_key), error: null };
          },
        };
        return query;
      },
      insert(values: Record<string, unknown>) {
        if (!written(values.user_id, values.dedupe_key)) return table.insert(values);

        return {
          select: () => ({
            single: async () => ({
              data: null,
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "mobile_notifications_user_dedupe_key_idx"',
              },
            }),
          }),
        };
      },
    };
  }

  return {
    ...history,
    from: (table: string) => (table === 'mobile_notifications' ? notifications() : history.from(table)),
  } as unknown as MobileNotificationHistory;
}
