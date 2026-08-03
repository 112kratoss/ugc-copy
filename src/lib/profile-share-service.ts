import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { findShareableProfileByUsername } from '@/lib/profile-server';
import { recordProfileShareEvent } from '@/lib/profile-share-events';
import {
  type GenerationShareChannel,
  type ProfileShareSourceSurface,
  isGenerationShareChannel,
  isProfileShareSourceSurface,
} from '@/lib/share';

export type ProfileSharePayload = {
  username: string;
  sourceSurface: ProfileShareSourceSurface;
  channel: GenerationShareChannel;
};

export type ProfileShareServiceDependencies = {
  findShareableProfileByUsername: typeof findShareableProfileByUsername;
  isUserRelationshipBlocked: typeof isUserRelationshipBlocked;
  recordProfileShareEvent: typeof recordProfileShareEvent;
};

export type ProfileShareServiceResult =
  | {
      ok: true;
      body: {
        success: true;
      };
    }
  | {
      ok: false;
      status: 400 | 404;
      body: {
        error: string;
      };
    };

export type ProfileSharePayloadResult =
  | {
      ok: true;
      payload: ProfileSharePayload;
    }
  | {
      ok: false;
      status: 400;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<ProfileShareServiceDependencies> | undefined,
): ProfileShareServiceDependencies {
  return {
    findShareableProfileByUsername:
      dependencies?.findShareableProfileByUsername ?? findShareableProfileByUsername,
    isUserRelationshipBlocked: dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
    recordProfileShareEvent: dependencies?.recordProfileShareEvent ?? recordProfileShareEvent,
  };
}

async function isProfileInteractionUnavailable({
  actorUserId,
  creatorUserId,
  dependencies,
  serviceClient,
}: {
  actorUserId: string | null;
  creatorUserId: string | null | undefined;
  dependencies: ProfileShareServiceDependencies;
  serviceClient: SupabaseClient;
}) {
  if (!actorUserId || !creatorUserId || creatorUserId === actorUserId) return false;

  try {
    return await dependencies.isUserRelationshipBlocked({
      adminSupabase: serviceClient,
      firstUserId: actorUserId,
      secondUserId: creatorUserId,
    });
  } catch (error) {
    logBackendError('failed_to_verify_block_state_before_sharing_creator_profile', { error: error });
    return true;
  }
}

export function parseProfileSharePayloadForRoute(body: {
  username?: unknown;
  sourceSurface?: unknown;
  channel?: unknown;
}): ProfileSharePayloadResult {
  if (!body.username || typeof body.username !== 'string') {
    return {
      ok: false,
      status: 400,
      body: { error: 'Missing creator username' },
    };
  }

  if (
    !body.sourceSurface ||
    typeof body.sourceSurface !== 'string' ||
    !isProfileShareSourceSurface(body.sourceSurface)
  ) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid share source surface' },
    };
  }

  if (!body.channel || typeof body.channel !== 'string' || !isGenerationShareChannel(body.channel)) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid share channel' },
    };
  }

  return {
    ok: true,
    payload: {
      username: body.username,
      sourceSurface: body.sourceSurface,
      channel: body.channel,
    },
  };
}

export async function shareCreatorProfileForRoute({
  actorUserId,
  channel,
  dependencies,
  serviceClient,
  sourceSurface,
  username,
}: ProfileSharePayload & {
  actorUserId: string | null;
  dependencies?: Partial<ProfileShareServiceDependencies>;
  serviceClient: SupabaseClient;
}): Promise<ProfileShareServiceResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const profile = await resolvedDependencies.findShareableProfileByUsername(
    username,
    serviceClient,
  );

  if (!profile) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Only public creator profiles can be shared' },
    };
  }

  if (await isProfileInteractionUnavailable({
    actorUserId,
    creatorUserId: profile.id,
    dependencies: resolvedDependencies,
    serviceClient,
  })) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Only public creator profiles can be shared' },
    };
  }

  await resolvedDependencies.recordProfileShareEvent({
    profileUserId: profile.id,
    eventType: 'share_click',
    sourceSurface,
    channel,
    actorUserId,
  }, serviceClient);

  return {
    ok: true,
    body: { success: true },
  };
}
