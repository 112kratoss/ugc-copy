import 'server-only';

import { recordGenerationShareEvent } from '@/lib/generation-share-events';
import { isMissingPostsSchemaError } from '@/lib/posts-server';
import { createServiceClient } from '@/lib/server-helpers';
import type {
  GenerationShareChannel,
  GenerationShareEventType,
  GenerationShareSourceSurface,
} from '@/lib/share';

export async function recordPostShareEvent({
  postId,
  eventType,
  sourceSurface,
  channel,
  actorUserId,
}: {
  postId: string;
  eventType: GenerationShareEventType;
  sourceSurface: GenerationShareSourceSurface;
  channel?: GenerationShareChannel;
  actorUserId?: string | null;
}) {
  const adminSupabase = createServiceClient();

  try {
    const { error } = await adminSupabase.rpc('record_post_share_event', {
      p_post_id: postId,
      p_event_type: eventType,
      p_source_surface: sourceSurface,
      p_channel: channel ?? null,
      p_actor_user_id: actorUserId ?? null,
    });

    if (error) {
      throw error;
    }
  } catch (error) {
    if (isMissingPostsSchemaError(error)) {
      await recordGenerationShareEvent({
        generationId: postId,
        eventType,
        sourceSurface,
        channel,
        actorUserId,
      });
      return;
    }

    console.error('Failed to record post share event:', error);
  }
}
