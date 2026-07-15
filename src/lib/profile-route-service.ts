import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  PROFILE_UPDATE_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  buildProfileApiResponse,
  PROFILE_SELECT_FIELDS,
  validateProfileSubmission,
  type ProfileRow,
} from '@/lib/profile-server';
import {
  buildFallbackUsername,
  getAuthAvatarUrl,
  getCreatorDisplayName,
  type ProfileApiResponse,
  type ProfileFieldErrors,
  type ProfileUpdatePayload,
} from '@/lib/profile';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';

export type ProfileRouteClient =
  Parameters<typeof enforceBackendRateLimit>[0]
  & SupabaseClient;

export type ProfileRouteUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

export type ProfileRouteResult =
  | {
    ok: true;
    response: ProfileApiResponse;
  }
  | {
    ok: false;
    status: number;
    error: string;
    fieldErrors?: ProfileFieldErrors;
    code?: string;
    retryAfterSeconds?: number;
    limit?: number;
    remaining?: number;
    resetAt?: string;
  };

type ProfileRouteClientInput = ProfileRouteClient | (() => ProfileRouteClient);

function resolveClient(client: ProfileRouteClientInput) {
  return typeof client === 'function' ? client() : client;
}

function buildStarterProfileApiResponse(user: ProfileRouteUser): ProfileApiResponse {
  const metadata = user.user_metadata ?? null;
  const metadataName =
    typeof metadata?.full_name === 'string'
      ? metadata.full_name
      : typeof metadata?.name === 'string'
        ? metadata.name
        : null;

  return {
    id: user.id,
    username: null,
    suggestedUsername: buildFallbackUsername(user.id),
    displayName: getCreatorDisplayName({
      displayName: metadataName,
      email: user.email ?? null,
    }),
    bio: null,
    avatarUrl: getAuthAvatarUrl(metadata),
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    credits: null,
  };
}

function mapRateLimitError(error: BackendRateLimitError): ProfileRouteResult {
  return {
    ok: false,
    status: error.status,
    error: error.message,
    code: 'RATE_LIMITED',
    retryAfterSeconds: error.retryAfterSeconds,
    limit: error.state.limit,
    remaining: error.state.remaining,
    resetAt: error.state.resetAt,
  };
}

export async function getProfileForRoute({
  user,
  client,
}: {
  user: ProfileRouteUser;
  client: ProfileRouteClientInput;
}): Promise<ProfileRouteResult> {
  const resolvedClient = resolveClient(client);
  const { data: profile, error } = await resolvedClient
    .from('profiles')
    .select(PROFILE_SELECT_FIELDS)
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    console.error('Failed to fetch profile:', error);
    return {
      ok: false,
      status: 500,
      error: 'Failed to fetch profile',
    };
  }

  if (!profile) {
    return {
      ok: true,
      response: buildStarterProfileApiResponse(user),
    };
  }

  return {
    ok: true,
    response: buildProfileApiResponse(profile as ProfileRow, user.id),
  };
}

export async function updateProfileForRoute({
  userId,
  body,
  client,
  invalidateFeedCache = invalidateShowcaseFeedCache,
}: {
  userId: string;
  body: unknown;
  client: ProfileRouteClientInput;
  invalidateFeedCache?: typeof invalidateShowcaseFeedCache;
}): Promise<ProfileRouteResult> {
  const resolvedClient = resolveClient(client);
  try {
    await enforceBackendRateLimit(resolvedClient, {
      ...PROFILE_UPDATE_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return mapRateLimitError(error);
    }

    console.error('Profile update rate limit check failed:', error);
    return {
      ok: false,
      status: 500,
      error: 'Failed to check profile update limits.',
    };
  }

  const validation = await validateProfileSubmission(
    resolvedClient,
    userId,
    body as ProfileUpdatePayload
  );
  if (!validation.ok) {
    return {
      ok: false,
      status: validation.status,
      error: validation.body.error,
      fieldErrors: validation.body.fieldErrors,
    };
  }

  const profileValues = {
    id: userId,
    username: validation.payload.data.username ?? validation.existingUsername,
    display_name: validation.payload.data.displayName,
    bio: validation.payload.data.bio,
    avatar_url: validation.payload.data.avatarUrl,
    cover_url: validation.payload.data.coverUrl,
    website_url: validation.payload.data.websiteUrl,
    twitter_handle: validation.payload.data.twitterHandle,
    instagram_handle: validation.payload.data.instagramHandle,
    tiktok_handle: validation.payload.data.tiktokHandle,
    location: validation.payload.data.location,
  };

  const { data: updatedProfile, error: updateError } = await resolvedClient
    .from('profiles')
    .upsert(profileValues, {
      onConflict: 'id',
    })
    .select(PROFILE_SELECT_FIELDS)
    .single();

  if (updateError) {
    if (updateError.code === '23505') {
      return {
        ok: false,
        status: 409,
        error: 'That username is already taken.',
        fieldErrors: { username: 'That username is already taken.' },
      };
    }

    console.error('Failed to update profile:', updateError);
    return {
      ok: false,
      status: 500,
      error: 'Failed to update profile',
    };
  }

  invalidateFeedCache();

  return {
    ok: true,
    response: buildProfileApiResponse(updatedProfile as ProfileRow, userId),
  };
}
