import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { createServiceClient } from '@/lib/server-helpers';
import type {
  GenerationShareChannel,
  GenerationShareEventType,
  GenerationShareSourceSurface,
} from '@/lib/share';

export async function recordGenerationShareEvent({
  generationId,
  eventType,
  sourceSurface,
  channel,
  actorUserId,
}: {
  generationId: string;
  eventType: GenerationShareEventType;
  sourceSurface: GenerationShareSourceSurface;
  channel?: GenerationShareChannel;
  actorUserId?: string | null;
}) {
  const adminSupabase = createServiceClient();

  try {
    const { error } = await adminSupabase.rpc('record_generation_share_event', {
      p_generation_id: generationId,
      p_event_type: eventType,
      p_source_surface: sourceSurface,
      p_channel: channel ?? null,
      p_actor_user_id: actorUserId ?? null,
    });

    if (error) {
      throw error;
    }
  } catch (error) {
    logBackendError('failed_to_record_generation_share_event', { error: error });
  }
}
