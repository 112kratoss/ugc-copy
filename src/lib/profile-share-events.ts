import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createServiceClient } from '@/lib/server-helpers';
import type {
  GenerationShareChannel,
  GenerationShareEventType,
  ProfileShareSourceSurface,
} from '@/lib/share';

export async function recordProfileShareEvent({
  profileUserId,
  eventType,
  sourceSurface,
  channel,
  actorUserId,
}: {
  profileUserId: string;
  eventType: GenerationShareEventType;
  sourceSurface: ProfileShareSourceSurface;
  channel?: GenerationShareChannel;
  actorUserId?: string | null;
}, serviceClient?: SupabaseClient) {
  const adminSupabase = serviceClient ?? createServiceClient();

  try {
    const { error } = await adminSupabase.rpc('record_profile_share_event', {
      p_profile_user_id: profileUserId,
      p_event_type: eventType,
      p_source_surface: sourceSurface,
      p_channel: channel ?? null,
      p_actor_user_id: actorUserId ?? null,
    });

    if (error) {
      throw error;
    }
  } catch (error) {
    logBackendError('failed_to_record_profile_share_event', { error: error });
  }
}
