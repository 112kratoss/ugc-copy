import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  CREATOR_FOLLOW_MUTATION_RATE_LIMIT,
  CREATOR_FOLLOW_NOTIFICATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { notifyCreatorFollowed } from '@/lib/mobile-notifications';

export type ProfileFollowServiceClient =
  Parameters<typeof enforceBackendRateLimit>[0]
  & SupabaseClient;

export type ProfileFollowRouteResult =
  | {
    ok: true;
    body: {
      following: boolean;
    } | {
      success: true;
    };
  }
  | {
    ok: false;
    status: 400 | 404 | 429 | 500;
    body: Record<string, unknown>;
    rateLimitError?: BackendRateLimitError;
  };

type ProfileFollowClientInput = ProfileFollowServiceClient | (() => ProfileFollowServiceClient);

function resolveClient(client: ProfileFollowClientInput) {
  return typeof client === 'function' ? client() : client;
}

function readFollowingId(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? typeof (value as { followingId?: unknown }).followingId === 'string'
      ? (value as { followingId: string }).followingId.trim()
      : ''
    : '';
}

function readFollowingIntent(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? typeof (value as { following?: unknown }).following === 'boolean'
      ? (value as { following: boolean }).following
      : null
    : null;
}

function createRateLimitResult(error: BackendRateLimitError): ProfileFollowRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

function missingCreatorProfile(): ProfileFollowRouteResult {
  return { ok: false, status: 400, body: { error: 'Missing creator profile.' } };
}

async function loadFollowRecord(
  adminSupabase: ProfileFollowServiceClient,
  followerId: string,
  followingId: string
) {
  return adminSupabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', followerId)
    .eq('following_id', followingId)
    .maybeSingle();
}

async function loadFollowerUsername(
  adminSupabase: ProfileFollowServiceClient,
  followerId: string
) {
  const { data } = await adminSupabase
    .from('profiles')
    .select('username')
    .eq('id', followerId)
    .maybeSingle();

  return typeof data?.username === 'string' ? data.username : null;
}

export async function getCreatorFollowStateForRoute({
  adminSupabase,
  followerId,
  followingId,
}: {
  adminSupabase: ProfileFollowClientInput;
  followerId: string;
  followingId: string;
}): Promise<ProfileFollowRouteResult> {
  if (!followingId || followingId === followerId) {
    return missingCreatorProfile();
  }

  const resolvedClient = resolveClient(adminSupabase);
  const { data, error } = await loadFollowRecord(resolvedClient, followerId, followingId);
  if (error) {
    return { ok: false, status: 500, body: { error: 'Failed to load follow state.' } };
  }

  return { ok: true, body: { following: Boolean(data) } };
}

export async function updateCreatorFollowForRoute({
  adminSupabase,
  followerId,
  body,
}: {
  adminSupabase: ProfileFollowClientInput;
  followerId: string;
  body: unknown;
}): Promise<ProfileFollowRouteResult> {
  const followingId = readFollowingId(body);
  const following = readFollowingIntent(body);
  if (!followingId || followingId === followerId || following === null) {
    return missingCreatorProfile();
  }

  const resolvedClient = resolveClient(adminSupabase);
  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...CREATOR_FOLLOW_MUTATION_RATE_LIMIT,
      key: followerId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    console.error('Creator follow rate limit check failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check follow limits.' } };
  }

  const { data: existingFollow, error: lookupError } = await loadFollowRecord(resolvedClient, followerId, followingId);
  if (lookupError) {
    return { ok: false, status: 500, body: { error: 'Failed to verify follow state.' } };
  }

  if (following) {
    if (!existingFollow) {
      const { error: insertError } = await resolvedClient.from('follows').insert({
        follower_id: followerId,
        following_id: followingId,
      });
      if (insertError) {
        return { ok: false, status: 500, body: { error: 'Failed to follow creator.' } };
      }

      const followerUsername = await loadFollowerUsername(resolvedClient, followerId);
      await notifyCreatorFollowed(resolvedClient, {
        followerUserId: followerId,
        followingUserId: followingId,
        followerUsername,
      });
    }

    return { ok: true, body: { following: true } };
  }

  const { error: deleteError } = await resolvedClient
    .from('follows')
    .delete()
    .eq('follower_id', followerId)
    .eq('following_id', followingId);

  if (deleteError) {
    return { ok: false, status: 500, body: { error: 'Failed to remove follow.' } };
  }

  return { ok: true, body: { following: false } };
}

export async function notifyCreatorFollowForRoute({
  adminSupabase,
  followerId,
  body,
}: {
  adminSupabase: ProfileFollowClientInput;
  followerId: string;
  body: unknown;
}): Promise<ProfileFollowRouteResult> {
  const followingId = readFollowingId(body);
  if (!followingId || followingId === followerId) {
    return missingCreatorProfile();
  }

  const resolvedClient = resolveClient(adminSupabase);
  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...CREATOR_FOLLOW_NOTIFICATION_RATE_LIMIT,
      key: followerId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    console.error('Creator follow notification rate limit check failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check follow notification limits.' } };
  }

  const { data: followRecord, error: followError } = await loadFollowRecord(resolvedClient, followerId, followingId);
  if (followError) {
    return { ok: false, status: 500, body: { error: 'Failed to verify follow state.' } };
  }

  if (!followRecord) {
    return { ok: false, status: 404, body: { error: 'Follow not found.' } };
  }

  const followerUsername = await loadFollowerUsername(resolvedClient, followerId);
  await notifyCreatorFollowed(resolvedClient, {
    followerUserId: followerId,
    followingUserId: followingId,
    followerUsername,
  });

  return { ok: true, body: { success: true } };
}
