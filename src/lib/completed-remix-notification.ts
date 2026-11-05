import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isOwnOrLinkedAccountId } from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import { buildMobileNotificationDeepLink, createMobileNotification } from '@/lib/mobile-notifications';
import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { loadProfileHandle } from '@/lib/profile-server';
import { recordAuthoritativeFeedEvent } from '@/lib/showcase-feed-events-service';

/**
 * A finished remix is credited to the delivery the remixer started it from:
 * their latest `remix_start` on the original within this window. Sessions are
 * kept two days past expiry, so a delivery older than that is gone anyway.
 */
export const COMPLETED_REMIX_DELIVERY_LOOKBACK_HOURS = 48;

/**
 * A remix's two alerts to the creator of the post remixed (owner, 2026-11-05),
 * by the remixer's handle:
 *   finished  "@maya remixed your post", opening her page: her creation is
 *             hers alone until she posts it;
 *   posted    "@maya posted a remix of your post", opening her post.
 * With no handle to name, "Someone …", opening the post remixed. The database
 * turns the named words into those after a block, either way round, or the
 * remixer's account deletion (`unnamed_remix_alert_words`, 20261105150333), so
 * the two change together.
 */
export function remixAlertWords(
  event: 'finished' | 'posted',
  params: { remixerHandle: string | null; remixedPostId: string; remixPostId?: string | null },
) {
  const remixedPost = buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: params.remixedPostId });
  const handle = params.remixerHandle;
  if (event === 'finished') {
    return {
      title: handle ? `@${handle} remixed your post` : 'Someone remixed your post',
      body: 'They finished a new creation from it.',
      deepLink: handle ? buildMobileNotificationDeepLink({ kind: 'creatorProfile', username: handle }) : remixedPost,
    };
  }
  return {
    title: handle ? `@${handle} posted a remix of your post` : 'Someone posted a remix of your post',
    body: 'Their version is public now.',
    deepLink: handle && params.remixPostId
      ? buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: params.remixPostId })
      : remixedPost,
  };
}

async function notifyRemixedCreator(
  supabase: SupabaseClient,
  remix: { generation_id: string; post_id: string; actor_user_id: string },
  creatorUserId: string,
) {
  try {
    const remixerHandle = await loadProfileHandle(supabase, remix.actor_user_id);
    await createMobileNotification({
      adminSupabase: supabase,
      userId: creatorUserId,
      actorUserId: remix.actor_user_id,
      type: 'post_remixed',
      category: 'social',
      ...remixAlertWords('finished', { remixerHandle, remixedPostId: remix.post_id }),
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
 * one empty read and nothing else. A remix then reads its remixer's handle, for
 * the alert's name.
 *
 * Whether the remixer may be credited was settled when the run started: the
 * start keeps its source only where Remix would hand them the recipe
 * (`source-generation.ts`), so a pair blocked by then has no row here. A block
 * made while the run is in flight is not asked about here: the settlement has
 * written the row and raised the count by then, and the database stores the
 * alert without the remixer's name or page (20261105150333).
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
    // A run the creator made as a guest since linked to them is their own
    // remix too: publish files a guest-made creation under the account.
    if (!post?.user_id || await isOwnOrLinkedAccountId(supabase, post.user_id, remix.actor_user_id)) return;
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

type PostedRemixRow = {
  id: string;
  user_id: string | null;
  generation_id: string | null;
  visibility: string | null;
  remix_parent_post_id: string | null;
  remix_parent_user_id: string | null;
};

/**
 * A remix posted where everyone can see it tells the creator of the post it
 * remixed, once per creation (its dedupe key: a post taken down and posted
 * again, or made private and public again, is not news twice). Whom to tell is
 * the post's own credit (posts.remix_parent_post_id and remix_parent_user_id,
 * 20261105150143), never anything a request sends. Nobody hears of their own
 * remix, of a remix of a post since deleted, or of one across a block, either
 * way round; a block made later takes the name out in the database.
 *
 * Called once a publish or an edit has made the post public, behind the answer
 * where the route can (`sendDeferrableNotification`). Never throws: the post is
 * committed whatever becomes of its alert.
 */
export async function notifyPostedRemix(adminSupabase: SupabaseClient, params: { postId: string }) {
  try {
    const { data, error } = await adminSupabase
      .from('posts')
      .select('id, user_id, generation_id, visibility, remix_parent_post_id, remix_parent_user_id')
      .eq('id', params.postId)
      .maybeSingle();
    if (error) throw error;
    const post = data as PostedRemixRow | null;
    if (!post?.user_id || post.visibility !== 'public' || !post.remix_parent_post_id || !post.remix_parent_user_id) return;
    const creatorUserId = post.remix_parent_user_id;
    if (await isOwnOrLinkedAccountId(adminSupabase, creatorUserId, post.user_id)) return;

    const [remixedPost, blocked, remixerHandle] = await Promise.all([
      adminSupabase.from('posts').select('id').eq('id', post.remix_parent_post_id).maybeSingle(),
      isUserRelationshipBlocked({ adminSupabase, firstUserId: creatorUserId, secondUserId: post.user_id }),
      loadProfileHandle(adminSupabase, post.user_id),
    ]);
    if (remixedPost.error) throw remixedPost.error;
    if (!remixedPost.data || blocked) return;

    await createMobileNotification({
      adminSupabase,
      userId: creatorUserId,
      actorUserId: post.user_id,
      type: 'post_remixed',
      category: 'social',
      ...remixAlertWords('posted', {
        remixerHandle,
        remixedPostId: post.remix_parent_post_id,
        remixPostId: post.id,
      }),
      objectType: 'post',
      objectId: post.remix_parent_post_id,
      dedupeKey: `posted-remix:${post.generation_id ?? post.id}`,
    });
  } catch (error) {
    logBackendError('failed_to_notify_posted_remix', { error });
  }
}
