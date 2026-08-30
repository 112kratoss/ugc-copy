import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';
import { buildMobileNotificationDeepLink, createMobileNotification } from '@/lib/mobile-notifications';

/** The database ledger owns counting. Notification delivery is best effort and
 * deduped per output, including when settlement is retried after a crash.
 *
 * This runs on the tail of every successful settlement, so it asks its question
 * in a single indexed lookup: the ledger row exists only once the trigger has
 * attributed a finished output to a public source post, which means the
 * ordinary generation — the overwhelming majority, no lineage at all — pays for
 * one empty read and nothing else. */
export async function notifyCompletedRemix(supabase: SupabaseClient, predictionId: string) {
  try {
    const { data: remix, error } = await supabase.from('completed_post_remixes')
      .select('generation_id, post_id, actor_user_id, posts(user_id), generations!inner(prediction_id)')
      .eq('generations.prediction_id', predictionId)
      .eq('notification_eligible', true).maybeSingle();
    if (error) throw error;
    if (!remix) return;
    const post = Array.isArray(remix.posts) ? remix.posts[0] : remix.posts;
    if (!post?.user_id || post.user_id === remix.actor_user_id) return;
    await createMobileNotification({
      adminSupabase: supabase,
      userId: post.user_id,
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
