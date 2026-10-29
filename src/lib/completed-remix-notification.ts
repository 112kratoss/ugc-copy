import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';
import { buildMobileNotificationDeepLink, createMobileNotification } from '@/lib/mobile-notifications';
import { recordAuthoritativeFeedEvent } from '@/lib/showcase-feed-events-service';

/**
 * A finished remix is credited to the delivery the remixer started it from:
 * their latest `remix_start` on the original within this window. Sessions are
 * kept two days past expiry, so a delivery older than that is gone anyway.
 */
export const COMPLETED_REMIX_DELIVERY_LOOKBACK_HOURS = 48;

async function notifyRemixedCreator(
  supabase: SupabaseClient,
  remix: { generation_id: string; post_id: string; actor_user_id: string },
  creatorUserId: string,
) {
  try {
    await createMobileNotification({
      adminSupabase: supabase,
      userId: creatorUserId,
      actorUserId: remix.actor_user_id,
      type: 'post_remixed',
      category: 'social',
      title: 'Someone remixed your post',
      body: 'They finished a new creation from it.',
      deepLink: buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: remix.post_id }),
      objectType: 'post',
      objectId: remix.post_id,
      dedupeKey: `completed-remix:${remix.generation_id}`,
    });
  } catch (error) {
    logBackendError('failed_to_notify_completed_remix', { error });
  }
}

/** The database ledger owns counting. Notification delivery is best effort and
 * deduped per output, including when settlement is retried after a crash.
 *
 * This runs on the tail of every successful settlement, so it asks its question
 * in a single indexed lookup: the ledger row exists only once the trigger has
 * attributed a finished output to a public source post, which means the
 * ordinary generation — the overwhelming majority, no lineage at all — pays for
 * one empty read and nothing else.
 *
 * Whether the remixer may be credited was settled when the run started: the
 * start keeps its source only where Remix would hand them the recipe
 * (`source-generation.ts`), so a pair blocked by then has no row here. A block
 * made while the run is in flight is not asked again: the alert names nobody,
 * like the grouped save alert written across a block.
 *
 * The same row is v4's server-written `remix_complete` feed event: the remixer
 * finished a creation from the original. It is written beside the notification,
 * once per output (a retried settlement is a duplicate), never fails the
 * settlement, and waits no longer than its own short timeout. */
export async function notifyCompletedRemix(supabase: SupabaseClient, predictionId: string) {
  try {
    const { data: remix, error } = await supabase.from('completed_post_remixes')
      .select('generation_id, post_id, actor_user_id, completed_at, posts(user_id), generations!inner(prediction_id)')
      .eq('generations.prediction_id', predictionId)
      .eq('notification_eligible', true).maybeSingle();
    if (error) throw error;
    if (!remix) return;
    const post = Array.isArray(remix.posts) ? remix.posts[0] : remix.posts;
    if (!post?.user_id || post.user_id === remix.actor_user_id) return;
    await Promise.all([
      notifyRemixedCreator(supabase, remix, post.user_id),
      recordAuthoritativeFeedEvent(supabase, {
        eventType: 'remix_complete',
        viewerUserId: remix.actor_user_id,
        postId: remix.post_id,
        actionKey: remix.generation_id,
        occurredAt: typeof remix.completed_at === 'string' ? remix.completed_at : null,
        inferDeliveryFrom: {
          eventTypes: ['remix_start'],
          withinHours: COMPLETED_REMIX_DELIVERY_LOOKBACK_HOURS,
        },
      }),
    ]);
  } catch (error) {
    logBackendError('failed_to_notify_completed_remix', { error });
  }
}
