import type { SupabaseClient } from '@supabase/supabase-js';

import { POST_SAVE_PUSH_RATE_LIMIT } from '@/lib/backend-rate-limit';

/**
 * Notification history the real notifier can run against.
 *
 * It answers the two tables `createMobileNotification` touches before it
 * pushes, the one call a grouped notification makes in place of the first,
 * a post's save-alert push slot, and the calls that write a named save's alert
 * and take it back (`create_post_save_alert`, `withdraw_post_save_alert`,
 * `withdraw_post_save_alerts_between`), which read the saves the history has
 * seen recorded (`recordSave`: every save stands until one says otherwise).
 * It records what was looked up, written and taken back, and can hold every
 * notification at its first step. Holding is how a test stands in for a push
 * fan-out that has not finished: push is switched off in the preferences it
 * returns, so nothing here reaches the network.
 */
export function createMobileNotificationHistory() {
  const started: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const withdrawn: Array<Record<string, unknown>> = [];
  const withdrawnRows = new Set<number>();
  const pushClaims: Array<{ key: string; allowed: boolean }> = [];
  const claimCounts = new Map<string, number>();
  const preferenceReads: string[] = [];
  const referralEvents = new Map<string, Array<Record<string, unknown>>>();
  const saves = new Map<string, boolean>();
  let held: Promise<void> | null = null;
  let releaseHeld = () => {};

  const saveKey = (actorUserId: unknown, postId: unknown) => `${String(actorUserId)}:${String(postId)}`;
  const isSaved = (actorUserId: unknown, postId: unknown) => saves.get(saveKey(actorUserId, postId)) ?? true;
  const standingRow = (userId: unknown, dedupeKey: unknown) => sent.findIndex(
    (row, index) => !withdrawnRows.has(index) && row.user_id === userId && row.dedupe_key === dedupeKey,
  );
  const withdrawnRow = (userId: unknown, dedupeKey: unknown) => sent.findIndex(
    (row, index) => withdrawnRows.has(index) && row.user_id === userId && row.dedupe_key === dedupeKey,
  );

  function storedRow(values: Record<string, unknown>) {
    return {
      id: `notification-${sent.length}`,
      ...values,
      event_count: 1,
      is_read: false,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    };
  }

  return {
    /**
     * Dedupe keys, or aggregation keys for grouped notifications, in the order
     * the notifier began work on them.
     */
    started,
    /** Notification rows, in the order they were written (a named alert brought back is written again). */
    sent,
    /** Every take-back asked for, in order: `user_id` / `dedupe_key`, or the two accounts of a block. */
    withdrawn,
    /** Indexes into `sent` of rows taken back. */
    withdrawnRows,
    /** Records a save or an unsave, as `set_post_save_state` leaves it. */
    recordSave(actorUserId: unknown, postId: unknown, saved: boolean) {
      saves.set(saveKey(actorUserId, postId), saved);
    },
    /**
     * Every claim on a rate-limited push slot, in order: a slot is free once
     * per key, as one quarter-hour window is.
     */
    pushClaims,
    /**
     * The recipient of every written alert that went on to decide whether to
     * push, which starts by reading their preferences. An alert whose push
     * slot was refused never does.
     */
    preferenceReads,
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
                    return { data: storedRow(values), error: null };
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
              eq(_column: string, value: unknown) {
                return {
                  async maybeSingle() {
                    preferenceReads.push(String(value));
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
    handlesRpc(name: string, args: Record<string, unknown> = {}) {
      return name === 'upsert_mobile_notification'
        || name === 'deliver_referral_reward_notifications'
        || name === 'create_post_save_alert'
        || name === 'withdraw_post_save_alert'
        || name === 'withdraw_post_save_alerts_between'
        // Only a post's save-alert push slot: other rate limits stay the client's.
        || (name === 'check_backend_rate_limit' && args.p_scope === POST_SAVE_PUSH_RATE_LIMIT.scope);
    },
    /**
     * A grouped notification (a save or a share) is written by one call that
     * either starts a group or adds to one. Here it always starts one, which
     * is the case that goes on to push.
     */
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
      if (name === 'create_post_save_alert') {
        const dedupeKey = `post-save:${String(args.p_actor_user_id)}:${String(args.p_post_id)}`;
        started.push(dedupeKey);
        await held;
        if (!isSaved(args.p_actor_user_id, args.p_post_id)) return { data: { created: false }, error: null };

        const standing = standingRow(args.p_recipient_user_id, dedupeKey);
        if (standing >= 0) {
          return { data: { created: false, notification: storedRow(sent[standing]) }, error: null };
        }
        const values = {
          user_id: args.p_recipient_user_id,
          actor_user_id: args.p_actor_user_id,
          type: 'post_saved',
          category: 'social',
          title: args.p_title,
          body: args.p_body,
          deep_link: args.p_deep_link,
          object_type: 'post',
          object_id: args.p_post_id,
          dedupe_key: dedupeKey,
          aggregation_key: null,
        };
        // A taken-back alert comes back as new: written again, the old row gone.
        const brought = withdrawnRow(args.p_recipient_user_id, dedupeKey);
        if (brought >= 0) sent[brought] = { ...sent[brought], revived: true };
        sent.push(values);
        return { data: { created: true, notification: storedRow(values) }, error: null };
      }
      if (name === 'withdraw_post_save_alert') {
        const dedupeKey = `post-save:${String(args.p_actor_user_id)}:${String(args.p_post_id)}`;
        withdrawn.push({ user_id: args.p_recipient_user_id, dedupe_key: dedupeKey });
        if (isSaved(args.p_actor_user_id, args.p_post_id)) return { data: 0, error: null };
        const standing = standingRow(args.p_recipient_user_id, dedupeKey);
        if (standing < 0) return { data: 0, error: null };
        withdrawnRows.add(standing);
        return { data: 1, error: null };
      }
      if (name === 'withdraw_post_save_alerts_between') {
        const first = String(args.p_first_user_id);
        const second = String(args.p_second_user_id);
        withdrawn.push({ between: [first, second] });
        let count = 0;
        sent.forEach((row, index) => {
          if (withdrawnRows.has(index) || row.type !== 'post_saved' || typeof row.dedupe_key !== 'string') return;
          const naming = (owner: string, named: string) => row.user_id === owner
            && (row.dedupe_key as string).startsWith(`post-save:${named}:`);
          if (naming(first, second) || naming(second, first)) {
            withdrawnRows.add(index);
            count += 1;
          }
        });
        return { data: count, error: null };
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
        actor_user_id: args.p_actor_user_id,
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
      sent.push(values);
      return { data: { notification: storedRow(values), wasCreated: true }, error: null };
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
      (row, rowIndex) => !history.withdrawnRows.has(rowIndex) && row.user_id === userId && row.dedupe_key === dedupeKey,
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
