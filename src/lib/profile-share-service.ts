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

/**
 * A share made from the product (`share_click`, through a channel), or an
 * arrival from a shared link (`share_visit`). The creator page sends the visit
 * from the browser since it is cached for everyone (2026-11-04): it recorded
 * the visit itself while it was drawn per request.
 */
export type ProfileSharePayload =
  | {
      eventType?: 'share_click';
      username: string;
      sourceSurface: ProfileShareSourceSurface;
      channel: GenerationShareChannel;
    }
  | {
      eventType: 'share_visit';
      username: string;
      sourceSurface: ProfileShareSourceSurface;
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

/**
 * A visit's marker as the page read it: any value still marks an arrival from
 * a share, filed as the creator page it landed on, as the post's visits file an
 * unknown marker as its own page.
 */
function getProfileShareVisitSourceSurface(value: unknown): ProfileShareSourceSurface | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  return isProfileShareSourceSurface(value) ? value : 'creator-profile';
}

export function parseProfileSharePayloadForRoute(body: {
  username?: unknown;
  sourceSurface?: unknown;
  channel?: unknown;
  eventType?: unknown;
}): ProfileSharePayloadResult {
  if (!body.username || typeof body.username !== 'string') {
    return {
      ok: false,
      status: 400,
      body: { error: 'Missing creator username' },
    };
  }

  if (body.eventType != null && body.eventType !== 'share_click' && body.eventType !== 'share_visit') {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid share event type' },
    };
  }

  if (body.eventType === 'share_visit') {
    const sourceSurface = getProfileShareVisitSourceSurface(body.sourceSurface);
    if (!sourceSurface) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Invalid share source surface' },
      };
    }

    // No channel: a visit did not go out through one.
    return {
      ok: true,
      payload: { eventType: 'share_visit', username: body.username, sourceSurface },
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
  dependencies,
  serviceClient,
  ...payload
}: ProfileSharePayload & {
  actorUserId: string | null;
  dependencies?: Partial<ProfileShareServiceDependencies>;
  serviceClient: SupabaseClient;
}): Promise<ProfileShareServiceResult> {
  const { username, sourceSurface } = payload;
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

  if (payload.eventType === 'share_visit') {
    // As the creator page recorded a visit while it was drawn per request: no
    // channel and no actor. The actor is checked above all the same, so a
    // visit across a block either way is not recorded.
    await resolvedDependencies.recordProfileShareEvent({
      profileUserId: profile.id,
      eventType: 'share_visit',
      sourceSurface,
    }, serviceClient);

    return {
      ok: true,
      body: { success: true },
    };
  }

  await resolvedDependencies.recordProfileShareEvent({
    profileUserId: profile.id,
    eventType: 'share_click',
    sourceSurface,
    channel: payload.channel,
    actorUserId,
  }, serviceClient);

  return {
    ok: true,
    body: { success: true },
  };
}
