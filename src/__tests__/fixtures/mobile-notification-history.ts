import type { SupabaseClient } from '@supabase/supabase-js';

import { POST_SAVE_PUSH_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { isClaimedProfileUsername, normalizeUsername } from '@/lib/profile';

/**
 * Notification history the real notifier can run against.
 *
 * It answers the two tables `createMobileNotification` touches before it
 * pushes, the one call a grouped notification makes in place of the first
 * (`upsert_mobile_notification`: a group's first event writes its row, a later
 * one adds to it, and a save or share row keeps no actor, as the SQL does), the
 * call that writes a named save's alert (`create_post_save_alert`), and a
 * post's save-alert push slot. A named alert goes to the post's owner
 * (`posts`), names only a saver told on record by a handle they chose
 * (`savers`), and belongs to its save as the database ties it: unsaving
 * (`recordSave`, which `withMobileNotificationHistory` calls as
 * `set_post_save_state` answers) removes it, a block between the two accounts
 * (`recordBlock`) removes it, and none is written for a save that does not
 * stand, across a block, or twice. As in the database, no save stands until
 * one is recorded.
 *
 * A sale's alert names its buyer by the handle `profiles` gives them. Without
 * `profiles` a profile read goes to the client, as any other table does.
 *
 * Push is switched off for every account unless `pushTo` names it with the
 * Expo tokens of its live devices. Then the real push path runs against these
 * tables, and against whatever a test stubs in as `fetch` for Expo
 * (`createExpoPushService`), so nothing here reaches the network.
 *
 * It records what was looked up, written, removed and pushed, and can hold
 * every notification at its first step. Holding is how a test stands in for a
 * push fan-out that has not finished.
 */
export function createMobileNotificationHistory({
  pushTo = {},
  posts = {},
  savers = {},
  profiles,
}: {
  /**
   * Accounts with push switched on, and the Expo token of each live device
   * they hold (none at all is allowed). Read at every step, so a test may
   * switch a phone on midway.
   */
  pushTo?: Record<string, string[]>;
  /** The posts a named save alert may announce, each with the account that owns it. */
  posts?: Record<string, string>;
  /** Saving accounts' profiles: their handle, and whether their telling is on record. */
  savers?: Record<string, { username: string | null; told: boolean }>;
  /**
   * Accounts' handles as `profiles.username` holds them (null: none), read by
   * a sale's alert. An account left out has no profile row.
   */
  profiles?: Record<string, string | null>;
} = {}) {
  const started: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const removedRows = new Set<number>();
  const rowEventCounts = new Map<number, number>();
  const groups = new Map<string, number>();
  const pushClaims: Array<{ key: string; allowed: boolean }> = [];
  const claimCounts = new Map<string, number>();
  const preferenceReads: string[] = [];
  const tokenReads: string[] = [];
  const pushed: Array<{ user_id: unknown; title: unknown; expo_push_token: unknown }> = [];
  /** Each reservation by its id, while it stands: a released one leaves `pushed`. */
  const reservations = new Map<string, (typeof pushed)[number]>();
  const outcomes: Array<Record<string, unknown>> = [];
  const referralEvents = new Map<string, Array<Record<string, unknown>>>();
  const saves = new Map<string, boolean>();
  const blocks = new Set<string>();
  let held: Promise<void> | null = null;
  let releaseHeld = () => {};

  const saveKey = (actorUserId: unknown, postId: unknown) => `${String(actorUserId)}:${String(postId)}`;
  const pairKey = (first: unknown, second: unknown) => [String(first), String(second)].sort().join(':');
  const isSaved = (actorUserId: unknown, postId: unknown) => saves.get(saveKey(actorUserId, postId)) ?? false;
  const standingRow = (userId: unknown, dedupeKey: unknown) => sent.findIndex(
    (row, index) => !removedRows.has(index) && row.user_id === userId && row.dedupe_key === dedupeKey,
  );
  const removeNamedAlerts = (names: (row: Record<string, unknown>) => boolean) => {
    sent.forEach((row, index) => {
      if (row.save_user_id !== undefined && row.save_user_id !== null && names(row)) removedRows.add(index);
    });
  };

  function storedRow(index: number) {
    return {
      id: `notification-${index + 1}`,
      ...sent[index],
      event_count: rowEventCounts.get(index) ?? 1,
      is_read: false,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    };
  }

  /** The row a delivery names, by the id `storedRow` gave it, while it stands. */
  function rowById(id: unknown) {
    const match = /^notification-(\d+)$/.exec(String(id));
    const index = match ? Number(match[1]) - 1 : -1;
    return index >= 0 && !removedRows.has(index) ? sent[index] : undefined;
  }

  return {
    /**
     * Dedupe keys, or aggregation keys for grouped notifications, in the order
     * the notifier began work on them.
     */
    started,
    /**
     * Notification rows, in the order they were first written. A grouped
     * alert's later events change its row in place; a named alert written
     * again after its save came back is a new row.
     */
    sent,
    /** Indexes into `sent` of named alerts gone with their save, or removed by a block. */
    removedRows,
    /** The rows in `sent` that still stand. */
    standing() {
      return sent.filter((_row, index) => !removedRows.has(index));
    },
    /** How many events each row in `sent` holds, in the same order. */
    eventCounts() {
      return sent.map((_row, index) => rowEventCounts.get(index) ?? 1);
    },
    /**
     * Records a save or an unsave, as `set_post_save_state` leaves it. An
     * unsave deletes the post_saves row, and with it the named alert that
     * announced it (the foreign key's ON DELETE CASCADE).
     */
    recordSave(actorUserId: unknown, postId: unknown, saved: boolean) {
      saves.set(saveKey(actorUserId, postId), saved);
      if (!saved) {
        removeNamedAlerts((row) => String(row.save_user_id) === String(actorUserId)
          && String(row.save_post_id) === String(postId));
      }
    },
    /**
     * A block between two accounts, either way round: the save alerts naming
     * either to the other go (the user_blocks trigger), and none is written
     * between them after it.
     */
    recordBlock(firstUserId: string, secondUserId: string) {
      blocks.add(pairKey(firstUserId, secondUserId));
      removeNamedAlerts((row) => (row.user_id === firstUserId && row.save_user_id === secondUserId)
        || (row.user_id === secondUserId && row.save_user_id === firstUserId));
    },
    /**
     * Every claim on a rate-limited push slot, in order: a slot is free once
     * per key, as one quarter-hour window is.
     */
    pushClaims,
    /**
     * The recipient of every alert written anew, which starts deciding whether
     * to push by reading their preferences. A later event of a group, or a
     * named alert the database did not write, never does.
     */
    preferenceReads,
    /**
     * The account whose live devices were looked up, for every alert written
     * anew whose preferences let a push go out. Only then is a push slot asked
     * for, and only when a device was found.
     */
    tokenReads,
    /**
     * Every push reserved, one per device, in order, less any whose reservation
     * was taken back (its slot refused) before it was sent.
     */
    pushed,
    /** The first sends' outcomes, as `record_initial_mobile_push_outcomes` was given them. */
    outcomes,
    enqueueReferralRewards(rewards: Array<Record<string, unknown>>) {
      for (const reward of rewards) {
        const eventKey = String(reward.event_key ?? reward.eventKey);
        const events = referralEvents.get(eventKey) ?? [];
        events.push({ user_id: reward.user_id ?? reward.userId, type: 'referral_reward_earned',
          dedupe_key: `referral-reward:${reward.id ?? reward.rewardId}:${eventKey}` });
        referralEvents.set(eventKey, events);
      }
    },
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
      return table === 'mobile_notifications'
        || table === 'mobile_notification_preferences'
        || table === 'mobile_push_tokens'
        || table === 'mobile_push_deliveries'
        || (table === 'profiles' && profiles !== undefined);
    },
    from(table: string) {
      if (table === 'mobile_notifications') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                if (column === 'dedupe_key') started.push(String(value));
                return query;
              },
              async maybeSingle() {
                // Whether an alert still stands, by its id.
                if (filters.id !== undefined) {
                  return { data: rowById(filters.id) ? { id: filters.id } : null, error: null };
                }
                await held;
                return { data: null, error: null };
              },
            };
            return query;
          },
          insert(values: Record<string, unknown>) {
            const index = sent.push(values) - 1;
            return {
              select() {
                return {
                  async single() {
                    return { data: storedRow(index), error: null };
                  },
                };
              },
            };
          },
          // What a push leaves on its alert once it has gone out.
          update() {
            return {
              async eq() {
                return { error: null };
              },
            };
          },
        };
      }

      if (table === 'mobile_notification_preferences') {
        return {
          select() {
            return {
              eq(_column: string, value: unknown) {
                return {
                  async maybeSingle() {
                    preferenceReads.push(String(value));
                    return {
                      data: {
                        push_enabled: Object.hasOwn(pushTo, String(value)),
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

      if (table === 'mobile_push_tokens') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              then<Result>(resolve: (result: { data: Array<Record<string, string>>; error: null }) => Result) {
                const userId = String(filters.user_id);
                tokenReads.push(userId);
                const tokens = filters.is_active === true ? pushTo[userId] ?? [] : [];
                return Promise.resolve({
                  data: tokens.map((token, index) => ({
                    id: `token-${userId}-${index + 1}`,
                    expo_push_token: token,
                    platform: 'ios',
                  })),
                  error: null,
                }).then(resolve);
              },
            };
            return query;
          },
        };
      }

      if (table === 'mobile_push_deliveries') {
        return {
          // A push reserves one delivery per device before it calls Expo, all
          // in one statement, each held to its alert by the foreign key.
          async insert(rows: Record<string, unknown> | Array<Record<string, unknown>>) {
            const all = [rows].flat();
            if (all.some((row) => !rowById(row.notification_id))) {
              return { error: { code: '23503', message: 'violates foreign key constraint "mobile_push_deliveries_notification_id_fkey"' } };
            }
            for (const row of all) {
              const push = {
                user_id: row.user_id,
                title: rowById(row.notification_id)?.title,
                expo_push_token: row.expo_push_token,
              };
              pushed.push(push);
              reservations.set(String(row.id), push);
            }
            return { error: null };
          },
          // A reservation taken back, never sent.
          delete() {
            return {
              async in(_column: string, ids: unknown[]) {
                for (const id of ids) {
                  const push = reservations.get(String(id));
                  if (!push) continue;
                  reservations.delete(String(id));
                  pushed.splice(pushed.indexOf(push), 1);
                }
                return { error: null };
              },
            };
          },
        };
      }

      // Only the read a sale's alert makes: an account's handle, by its id.
      if (table === 'profiles' && profiles) {
        return {
          select(columns: string) {
            if (columns !== 'username') throw new Error(`Unexpected profiles read: ${columns}`);
            return {
              eq(column: string, userId: unknown) {
                if (column !== 'id') throw new Error(`Unexpected profiles filter: ${column}`);
                return {
                  async maybeSingle() {
                    const key = String(userId);
                    return { data: Object.hasOwn(profiles, key) ? { username: profiles[key] } : null, error: null };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected notification table: ${table}`);
    },
    handlesRpc(name: string, args: Record<string, unknown> = {}) {
      return name === 'upsert_mobile_notification'
        || name === 'deliver_referral_reward_notifications'
        || name === 'create_post_save_alert'
        || name === 'record_initial_mobile_push_outcomes'
        || name === 'finish_initial_mobile_push_outcomes'
        // Only a post's save-alert push slot: other rate limits stay the client's.
        || (name === 'check_backend_rate_limit' && args.p_scope === POST_SAVE_PUSH_RATE_LIMIT.scope);
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (name === 'check_backend_rate_limit') {
        const key = `${String(args.p_scope)}|${String(args.p_subject_key)}`;
        const count = (claimCounts.get(key) ?? 0) + 1;
        claimCounts.set(key, count);
        const limit = Number(args.p_limit);
        const allowed = count <= limit;
        pushClaims.push({ key: String(args.p_subject_key), allowed });
        return {
          data: {
            allowed,
            limit,
            remaining: Math.max(0, limit - count),
            retryAfterSeconds: allowed ? 0 : 60,
            resetAt: '2026-10-19T00:15:00.000Z',
          },
          error: null,
        };
      }
      if (name === 'record_initial_mobile_push_outcomes') {
        if (Array.isArray(args.p_items)) outcomes.push(...args.p_items as Array<Record<string, unknown>>);
        return { data: Array.isArray(args.p_items) ? args.p_items.length : 0, error: null };
      }
      if (name === 'finish_initial_mobile_push_outcomes') {
        return { data: Array.isArray(args.p_items) ? args.p_items.length : 0, error: null };
      }
      if (name === 'create_post_save_alert') {
        const postId = args.p_post_id;
        const actorUserId = args.p_saver_user_id;
        const dedupeKey = `post-save:${String(actorUserId)}:${String(postId)}`;
        started.push(dedupeKey);
        await held;

        // What the function answers whenever it writes nothing.
        const notWritten = { data: { nameable: true, wasCreated: false, notification: null }, error: null };
        // To whoever owns the post; a post gone took its saves with it.
        const recipientUserId = posts[String(postId)];
        if (!recipientUserId || recipientUserId === actorUserId) return notWritten;
        // Only a saver told on record, by a handle they chose.
        const saver = savers[String(actorUserId)];
        if (!saver?.told || !isClaimedProfileUsername(saver.username)) {
          return { data: { nameable: false, wasCreated: false, notification: null }, error: null };
        }
        if (blocks.has(pairKey(recipientUserId, actorUserId))) return notWritten;
        // ON CONFLICT (user_id, dedupe_key) DO NOTHING: this save's alert stands already.
        if (standingRow(recipientUserId, dedupeKey) >= 0) return notWritten;
        // The foreign key to post_saves: the save does not stand.
        if (!isSaved(actorUserId, postId)) return notWritten;

        const index = sent.push({
          user_id: recipientUserId,
          actor_user_id: actorUserId,
          type: 'post_saved',
          category: 'social',
          title: `@${normalizeUsername(saver.username)} saved your post`,
          body: args.p_body,
          deep_link: args.p_deep_link,
          object_type: 'post',
          object_id: postId,
          dedupe_key: dedupeKey,
          aggregation_key: null,
          save_user_id: actorUserId,
          save_post_id: postId,
        }) - 1;
        return { data: { nameable: true, wasCreated: true, notification: storedRow(index) }, error: null };
      }
      if (name === 'deliver_referral_reward_notifications') {
        const event = referralEvents.get(String(args.p_event_key))?.shift();
        if (!event) return { data: { processed: 0, delivered: 0, failed: 0 }, error: null };
        started.push(String(event.dedupe_key));
        await held;
        sent.push(event);
        return { data: { processed: 1, delivered: 1, failed: 0 }, error: null };
      }
      if (name !== 'upsert_mobile_notification') {
        throw new Error(`Unexpected notification call: ${name}`);
      }

      started.push(String(args.p_aggregation_key));
      await held;

      const values = {
        user_id: args.p_user_id,
        // The SQL stores no actor on a grouped save or share, whatever it is passed.
        actor_user_id: args.p_type === 'post_saved' || args.p_type === 'post_shared' ? null : args.p_actor_user_id,
        type: args.p_type,
        category: args.p_category,
        title: args.p_title,
        body: args.p_body,
        deep_link: args.p_deep_link,
        object_type: args.p_object_type,
        object_id: args.p_object_id,
        dedupe_key: args.p_dedupe_key,
        aggregation_key: args.p_aggregation_key,
      };
      // ON CONFLICT (user_id, aggregation_key): a later event takes the group's
      // row, with the newest words and one more event, and is not written anew.
      const groupKey = `${String(args.p_user_id)}|${String(args.p_aggregation_key)}`;
      const group = groups.get(groupKey);
      if (group !== undefined) {
        sent[group] = { ...sent[group], ...values };
        rowEventCounts.set(group, (rowEventCounts.get(group) ?? 1) + 1);
        return { data: { notification: storedRow(group), wasCreated: false }, error: null };
      }
      const index = sent.push(values) - 1;
      groups.set(groupKey, index);
      return { data: { notification: storedRow(index), wasCreated: true }, error: null };
    },
  };
}

export type MobileNotificationHistory = ReturnType<typeof createMobileNotificationHistory>;

/** The same client, with its notification tables and its grouped-notification call served by `history`. */
export function withMobileNotificationHistory(
  client: SupabaseClient,
  history: MobileNotificationHistory,
): SupabaseClient {
  return {
    from: (table: string) => (history.handles(table) ? history.from(table) : client.from(table)),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      if (history.handlesRpc(name, args)) return history.rpc(name, args);
      const result = await client.rpc(name, args);
      if (name === 'settle_referral_purchase_rewards' && result.data?.rewards) {
        history.enqueueReferralRewards(result.data.rewards);
      }
      // What a named save's alert reads: the save as the save left it.
      if (name === 'set_post_save_state' && !result.error) {
        const state = Array.isArray(result.data) ? result.data[0] : result.data;
        if (typeof state?.is_saved === 'boolean') history.recordSave(args?.p_user_id, args?.p_post_id, state.is_saved);
      }
      return result;
    },
  } as unknown as SupabaseClient;
}

/**
 * Expo's push service, as a `fetch` a test stubs in for a history with push
 * on: every message gets a ticket, and each request it was sent is kept.
 */
export function createExpoPushService() {
  const requests: Array<Array<Record<string, unknown>>> = [];
  const expoFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== 'https://exp.host/--/api/v2/push/send') {
      throw new Error(`Unexpected request: ${String(input)}`);
    }
    const messages = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
    requests.push(messages);
    return new Response(JSON.stringify({
      data: messages.map((_message, index) => ({ status: 'ok', id: `ticket-${requests.length}-${index + 1}` })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: expoFetch as typeof fetch, requests };
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
      (row, rowIndex) => !history.removedRows.has(rowIndex) && row.user_id === userId && row.dedupe_key === dedupeKey,
    );
    return index < 0 ? null : { id: `notification-${index + 1}`, ...history.sent[index] };
  };

  function notifications() {
    const table = history.from('mobile_notifications') as unknown as {
      select(): DedupeLookup;
      insert(values: Record<string, unknown>): unknown;
      update(values: Record<string, unknown>): unknown;
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
      update(values: Record<string, unknown>) {
        return table.update(values);
      },
    };
  }

  return {
    ...history,
    from: (table: string) => (table === 'mobile_notifications' ? notifications() : history.from(table)),
  } as unknown as MobileNotificationHistory;
}
