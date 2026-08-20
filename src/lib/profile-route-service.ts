import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

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
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';
import {
  abortNullableUploadByteConsumption,
  completeUploadByteConsumptions,
  isDefinitiveSupabaseMutationRejection,
  type UploadConsumptionClaim,
} from '@/lib/upload-byte-admission';
import { finalizeUploadForConsumption } from '@/lib/upload-finalization';

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
    logBackendError('failed_to_fetch_profile', { error: error });
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

    logBackendError('profile_update_rate_limit_check_failed', { error: error });
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

  const submittedProfileMedia = [profileValues.avatar_url, profileValues.cover_url]
    .flatMap((value) => typeof value === 'string'
      ? [getUserOwnedStoredMediaLocation(value, userId)]
      : [])
    .filter((location): location is { bucket: string; filePath: string } => (
      location?.bucket === 'profiles'
    ))
    .filter((location, index, entries) => entries.findIndex((candidate) => (
      candidate.bucket === location.bucket && candidate.filePath === location.filePath
    )) === index);
  const consumptionClaims: UploadConsumptionClaim[] = [];
  try {
    for (const location of submittedProfileMedia) {
      const finalization = await finalizeUploadForConsumption(resolvedClient, {
        userId,
        bucket: location.bucket,
        storagePath: location.filePath,
        disposition: 'preserve',
      });
      if (!finalization.ok) {
        await Promise.all(consumptionClaims.map((claim) => (
          abortNullableUploadByteConsumption(resolvedClient, claim)
        )));
        return {
          ok: false,
          status: finalization.status,
          error: finalization.error,
          code: finalization.code,
        };
      }
      if (finalization.consumptionClaim) consumptionClaims.push(finalization.consumptionClaim);
    }
  } catch (error) {
    await Promise.all(consumptionClaims.map((claim) => (
      abortNullableUploadByteConsumption(resolvedClient, claim)
    )));
    logBackendError('failed_to_prepare_profile_upload_consumption', { error });
    return { ok: false, status: 500, error: 'Failed to verify profile media.' };
  }

  let updatedProfile: unknown = null;
  let updateError: { code?: string } | null = null;
  let updateStatus: number | undefined;
  try {
    const update = await resolvedClient
      .from('profiles')
      .upsert(profileValues, {
        onConflict: 'id',
      })
      .select(PROFILE_SELECT_FIELDS)
      .single();
    updatedProfile = update.data;
    updateError = update.error;
    updateStatus = update.status;
  } catch (error) {
    // A thrown PostgREST request may have committed before its response was
    // lost. Keep the leases active so expiry reconciliation preserves the
    // exact finalized objects instead of making a committed profile dangle.
    logBackendError('failed_to_update_profile', { error });
    return { ok: false, status: 500, error: 'Failed to update profile' };
  }

  if (updateError) {
    if (isDefinitiveSupabaseMutationRejection({ error: updateError, status: updateStatus })) {
      await Promise.all(consumptionClaims.map((claim) => (
        abortNullableUploadByteConsumption(resolvedClient, claim)
      )));
    }
    if (updateError.code === '23505') {
      return {
        ok: false,
        status: 409,
        error: 'That username is already taken.',
        fieldErrors: { username: 'That username is already taken.' },
      };
    }

    logBackendError('failed_to_update_profile', { error: updateError });
    return {
      ok: false,
      status: 500,
      error: 'Failed to update profile',
    };
  }

  const completed = await completeUploadByteConsumptions(resolvedClient, consumptionClaims);
  if (!completed.ok) {
    return { ok: false, status: 500, error: completed.error };
  }

  invalidateFeedCache();

  return {
    ok: true,
    response: buildProfileApiResponse(updatedProfile as ProfileRow, userId),
  };
}
