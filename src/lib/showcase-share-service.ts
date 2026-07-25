import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUserRelationshipBlocked } from '@/lib/moderation-service';
import { notifyPostSocialActivity } from '@/lib/mobile-notifications';
import { recordPostShareEvent } from '@/lib/post-share-events';
import { findPublicPostReferenceByIdOrGenerationId } from '@/lib/posts-server';
import {
  type GenerationShareChannel,
  type GenerationShareSourceSurface,
  isGenerationShareChannel,
  isGenerationShareSourceSurface,
} from '@/lib/share';

type PostReference = {
  id: string;
  user_id?: string | null;
};

export type ShowcaseSharePayload = {
  referenceId: string;
  sourceSurface: GenerationShareSourceSurface;
  channel: GenerationShareChannel;
};

export type ShowcaseShareServiceDependencies = {
  findPublicPostReferenceByIdOrGenerationId: typeof findPublicPostReferenceByIdOrGenerationId;
  isUserRelationshipBlocked: typeof isUserRelationshipBlocked;
  notifyPostSocialActivity: typeof notifyPostSocialActivity;
  recordPostShareEvent: typeof recordPostShareEvent;
};

export type ShowcaseShareServiceResult =
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

export type ShowcaseSharePayloadResult =
  | {
      ok: true;
      payload: ShowcaseSharePayload;
    }
  | {
      ok: false;
      status: 400;
      body: {
        error: string;
      };
    };

function resolveDependencies(
  dependencies: Partial<ShowcaseShareServiceDependencies> | undefined,
): ShowcaseShareServiceDependencies {
  return {
    findPublicPostReferenceByIdOrGenerationId:
      dependencies?.findPublicPostReferenceByIdOrGenerationId ?? findPublicPostReferenceByIdOrGenerationId,
    isUserRelationshipBlocked: dependencies?.isUserRelationshipBlocked ?? isUserRelationshipBlocked,
    notifyPostSocialActivity: dependencies?.notifyPostSocialActivity ?? notifyPostSocialActivity,
    recordPostShareEvent: dependencies?.recordPostShareEvent ?? recordPostShareEvent,
  };
}

async function isPostInteractionUnavailable({
  actorUserId,
  creatorUserId,
  dependencies,
  serviceClient,
}: {
  actorUserId: string | null;
  creatorUserId: string | null | undefined;
  dependencies: ShowcaseShareServiceDependencies;
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
    logBackendError('failed_to_verify_block_state_before_sharing_showcase_content', { error: error });
    return true;
  }
}

export function parseShowcaseSharePayloadForRoute(body: {
  generationId?: unknown;
  postId?: unknown;
  sourceSurface?: unknown;
  channel?: unknown;
}): ShowcaseSharePayloadResult {
  const referenceId = typeof body.postId === 'string' ? body.postId : body.generationId;

  if (!referenceId || typeof referenceId !== 'string') {
    return {
      ok: false,
      status: 400,
      body: { error: 'Missing post ID' },
    };
  }

  if (
    !body.sourceSurface ||
    typeof body.sourceSurface !== 'string' ||
    !isGenerationShareSourceSurface(body.sourceSurface)
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
      referenceId,
      sourceSurface: body.sourceSurface,
      channel: body.channel,
    },
  };
}

export async function shareShowcasePostForRoute({
  actorUserId,
  channel,
  dependencies,
  referenceId,
  serviceClient,
  sourceSurface,
}: ShowcaseSharePayload & {
  actorUserId: string | null;
  dependencies?: Partial<ShowcaseShareServiceDependencies>;
  serviceClient: SupabaseClient;
}): Promise<ShowcaseShareServiceResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const post = await resolvedDependencies.findPublicPostReferenceByIdOrGenerationId(
    referenceId,
    serviceClient,
  ) as PostReference | null;

  if (!post) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Only public creations can be shared' },
    };
  }
  if (await isPostInteractionUnavailable({
    actorUserId,
    creatorUserId: post.user_id,
    dependencies: resolvedDependencies,
    serviceClient,
  })) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Only public creations can be shared' },
    };
  }

  await resolvedDependencies.recordPostShareEvent({
    postId: post.id,
    eventType: 'share_click',
    sourceSurface,
    channel,
    actorUserId,
  }, serviceClient);

  if (actorUserId) {
    await resolvedDependencies.notifyPostSocialActivity(serviceClient, {
      type: 'post_shared',
      recipientUserId: post.user_id,
      actorUserId,
      postId: post.id,
    });
  }

  return {
    ok: true,
    body: { success: true },
  };
}
