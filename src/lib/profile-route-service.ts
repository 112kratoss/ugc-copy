import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';

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
  getReservedProfileUsernameError,
  type ProfileApiResponse,
  type ProfileFieldErrors,
  type ProfileFieldUpdate,
  type ProfileUpdatePayload,
} from '@/lib/profile';
import { parseOwnerPostSalesSummary } from '@/lib/owner-post-sales-summary';
import { parseOwnerProfileCounts } from '@/lib/owner-profile-counts';
import { invalidateShowcaseFeedCache } from '@/lib/showcase-feed-cache';
import { deriveNormalizedProfileImage } from '@/lib/profile-image-normalization';
import {
  getCanonicalStoredMediaLocation,
  getUserOwnedStoredMediaLocation,
} from '@/lib/storage-ownership';
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
    saverNoticeSeen: false,
  };
}

function presentColumns(columns: Record<string, ProfileFieldUpdate>): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(columns).filter((entry): entry is [string, string | null] => entry[1] !== undefined)
  );
}

/**
 * Releases the leases on uploads a normalised copy replaced, so the reclaim job
 * deletes them like any upload that was finalized and never saved. Best
 * effort: a lease that fails to release expires into the retained state, which
 * is what every profile upload got before, and the saved profile is unaffected.
 */
async function releaseSupersededProfileUploads(
  client: ProfileRouteClient,
  claims: readonly UploadConsumptionClaim[],
): Promise<void> {
  await Promise.all(claims.map(async (claim) => {
    const released = await abortNullableUploadByteConsumption(client, claim);
    if (!released.ok) {
      logBackendWarning('failed_to_release_superseded_profile_upload', {
        uploadId: claim.uploadId,
        error: released.error,
      });
    }
  }));
}

const PROFILE_MEDIA_BUCKET = 'profiles';

type StoredProfileMedia = { avatar_url: string | null; cover_url: string | null };

/**
 * The photos the profile showed before a save that sends one. Null when they
 * could not be read: nothing is then removed, and the earlier photo stays as
 * every replaced photo did before.
 */
async function readStoredProfileMedia(
  client: ProfileRouteClient,
  userId: string,
): Promise<StoredProfileMedia | null> {
  try {
    const { data, error } = await client
      .from('profiles')
      .select('avatar_url, cover_url')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    const row = (data ?? {}) as Partial<StoredProfileMedia>;
    return { avatar_url: row.avatar_url ?? null, cover_url: row.cover_url ?? null };
  } catch (error) {
    logBackendWarning('failed_to_read_profile_media_before_save', { error });
    return null;
  }
}

/**
 * The submitted profile photos that are a new upload a client is sending: a
 * file of the account's folder whose reservation no save has consumed yet.
 * Every other file of the folder a save can carry was put there by an earlier
 * save (a consumed upload, or a normalised copy, which has no reservation):
 * the photo the profile shows, or one a form still showed after another
 * device replaced it. Null when the reservations could not be read.
 */
async function readNewProfileUploads(
  client: ProfileRouteClient,
  userId: string,
  filePaths: string[],
): Promise<Set<string> | null> {
  if (filePaths.length === 0) return new Set();
  try {
    const { data, error } = await client
      .from('upload_byte_reservations')
      .select('storage_path, finalization_status')
      .eq('user_id', userId)
      .eq('bucket_id', PROFILE_MEDIA_BUCKET)
      .in('storage_path', filePaths);
    if (error) throw error;
    return new Set(((data ?? []) as Array<{ storage_path: string; finalization_status: string }>)
      .filter((row) => row.finalization_status !== 'consumed')
      .map((row) => row.storage_path));
  } catch (error) {
    logBackendError('failed_to_read_profile_upload_reservations', { error });
    return null;
  }
}

/**
 * Removes the photo a save replaced with one it uploaded: the avatar or cover
 * the profile showed before, for each column whose saved value is an upload
 * this request finalized or its normalised copy (`savedUploads`). Nothing else
 * replaces a photo: a clear, or a form re-sending what it showed, never
 * removes one. Only an object in this account's own folder of the profiles
 * bucket, and only when no profile names it once the save has landed (the
 * same file can be the avatar and the cover, and a guest linked to the account
 * keeps its own row); the read is made after the save, right before the
 * removal. A photo outside the folder (a sign-in provider's picture, a linked
 * guest's) is left alone. Never fails the save: a failed read or removal is
 * logged and leaves the file, as before.
 */
async function removeReplacedProfileMedia(
  client: ProfileRouteClient,
  userId: string,
  previous: StoredProfileMedia,
  saved: Partial<StoredProfileMedia>,
  savedUploads: ReadonlySet<string>,
): Promise<void> {
  const replaced = new Map<string, string>();
  for (const column of ['avatar_url', 'cover_url'] as const) {
    const savedValue = saved[column];
    const before = previous[column];
    if (!savedValue || !before || savedValue === before) continue;
    const savedLocation = getUserOwnedStoredMediaLocation(savedValue, userId, { allowedBuckets: [PROFILE_MEDIA_BUCKET] });
    if (!savedLocation || !savedUploads.has(savedLocation.filePath)) continue;
    const location = getUserOwnedStoredMediaLocation(before, userId, { allowedBuckets: [PROFILE_MEDIA_BUCKET] });
    if (location) replaced.set(location.filePath, location.filePath);
  }
  if (replaced.size === 0) return;

  try {
    const folder = `*/${PROFILE_MEDIA_BUCKET}/${userId}/*`;
    const { data, error } = await client
      .from('profiles')
      .select('id, avatar_url, cover_url')
      .or(`avatar_url.like.${folder},cover_url.like.${folder}`);
    if (error) throw error;
    for (const row of (data ?? []) as Array<Partial<StoredProfileMedia>>) {
      for (const value of [row.avatar_url, row.cover_url]) {
        const location = value
          ? getCanonicalStoredMediaLocation(value, { allowedBuckets: [PROFILE_MEDIA_BUCKET] })
          : null;
        if (location) replaced.delete(location.filePath);
      }
    }
    if (replaced.size === 0) return;

    const { error: removeError } = await client.storage
      .from(PROFILE_MEDIA_BUCKET)
      .remove([...replaced.keys()]);
    if (removeError) throw removeError;
  } catch (error) {
    logBackendWarning('failed_to_remove_replaced_profile_media', { error, paths: [...replaced.keys()] });
  }
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
  // The header counts and the seller totals ride along with the profile, so
  // every screen reads one number and the app's saved copy of the profile
  // carries them across launches. They run beside the select, never after it.
  const [{ data: profile, error }, totals] = await Promise.all([
    resolvedClient
      .from('profiles')
      .select(PROFILE_SELECT_FIELDS)
      .eq('id', user.id)
      .maybeSingle(),
    loadOwnerProfileTotals(resolvedClient, user.id),
  ]);

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
      response: { ...buildStarterProfileApiResponse(user), ...totals },
    };
  }

  return {
    ok: true,
    response: { ...buildProfileApiResponse(profile as ProfileRow, user.id), ...totals },
  };
}

/**
 * The totals `/api/profile` carries: the library counts and the seller
 * summary, each from its own service-role RPC. A count that fails is logged
 * and left out — the profile never fails over a number, and a missing field
 * makes the app draw its unknown placeholder rather than a 0. Exported so the
 * web's own profile page reads the same numbers as the app.
 */
export async function loadOwnerProfileTotals(
  client: ProfileRouteClient,
  userId: string,
): Promise<Pick<ProfileApiResponse, 'stats' | 'sales'>> {
  const [counts, sales] = await Promise.all([
    client.rpc('owner_profile_counts', { p_user_id: userId }),
    client.rpc('get_owner_post_sales_summary', { p_owner_id: userId }),
  ]);
  const totals: Pick<ProfileApiResponse, 'stats' | 'sales'> = {};
  if (counts.error) {
    logBackendError('failed_to_count_owner_profile_libraries', { error: counts.error });
  } else {
    totals.stats = parseOwnerProfileCounts(counts.data);
  }
  if (sales.error) {
    logBackendError('failed_to_load_owner_profile_sales', { error: sales.error });
  } else {
    totals.sales = parseOwnerPostSalesSummary(sales.data);
  }
  return totals;
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

  const { data } = validation.payload;
  const reservedUsernameError = getReservedProfileUsernameError(data.username, validation.existingUsername);
  if (reservedUsernameError) {
    return {
      ok: false,
      status: 400,
      error: reservedUsernameError,
      fieldErrors: { username: reservedUsernameError },
    };
  }

  const submittedProfileMedia = [data.avatarUrl, data.coverUrl]
    .flatMap((value) => {
      if (typeof value !== 'string') return [];
      const location = getUserOwnedStoredMediaLocation(value, userId);
      return location?.bucket === 'profiles' ? [{ url: value, location }] : [];
    })
    .filter((media, index, entries) => entries.findIndex((candidate) => (
      candidate.location.filePath === media.location.filePath
    )) === index);
  // What the profile showed, read when a save sends a photo: the photo a new
  // upload replaces goes once the new one is saved.
  const previousMedia = submittedProfileMedia.length > 0
    ? await readStoredProfileMedia(resolvedClient, userId)
    : null;
  // Only a new upload is taken from the request. A file the account's folder
  // already held is what the profile shows or what a form still showed after
  // another device replaced it: its column keeps the stored value, and is left
  // out of the write (a stale form neither brings back a photo nor fails).
  const newUploads = await readNewProfileUploads(
    resolvedClient,
    userId,
    submittedProfileMedia.map((media) => media.location.filePath),
  );
  if (!newUploads) {
    return { ok: false, status: 500, error: 'Failed to verify profile media.' };
  }
  const keptStoredColumns = (['avatarUrl', 'coverUrl'] as const).filter((field) => {
    const value = data[field];
    if (typeof value !== 'string') return false;
    const location = getUserOwnedStoredMediaLocation(value, userId);
    return location?.bucket === PROFILE_MEDIA_BUCKET && !newUploads.has(location.filePath);
  });
  const staleColumns = keptStoredColumns.filter((field) => (
    previousMedia && data[field] !== previousMedia[field === 'avatarUrl' ? 'avatar_url' : 'cover_url']
  ));
  if (staleColumns.length > 0) {
    logBackendWarning('profile_save_kept_stored_photo', { fields: staleColumns });
  }

  const consumptionClaims: UploadConsumptionClaim[] = [];
  // An upload the profile will point at is kept for good. One whose
  // normalised copy takes its place is referenced by nothing once the row is
  // written, so its lease is released to the reclaim job instead.
  const preservedClaims: UploadConsumptionClaim[] = [];
  const supersededClaims: UploadConsumptionClaim[] = [];
  const normalizedUrls = new Map<string, string>();
  // The files this save finalized or wrote as their normalised copies.
  const savedUploads = new Set<string>();
  try {
    for (const media of submittedProfileMedia.filter((candidate) => newUploads.has(candidate.location.filePath))) {
      const finalization = await finalizeUploadForConsumption(resolvedClient, {
        userId,
        bucket: media.location.bucket,
        storagePath: media.location.filePath,
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
      // Read under the lease, so the reclaim job cannot take the upload
      // mid-read. A failure is logged and ignored: the profile keeps the
      // upload it was given, a correct if oversized image, and the save goes on.
      const normalized = await deriveNormalizedProfileImage({
        adminSupabase: resolvedClient,
        filePath: media.location.filePath,
        sourceUrl: media.url,
      });
      savedUploads.add(media.location.filePath);
      if (normalized) {
        normalizedUrls.set(`${media.location.bucket}/${media.location.filePath}`, normalized.url);
        savedUploads.add(normalized.filePath);
      }
      if (finalization.consumptionClaim) {
        (normalized ? supersededClaims : preservedClaims).push(finalization.consumptionClaim);
      }
    }
  } catch (error) {
    await Promise.all(consumptionClaims.map((claim) => (
      abortNullableUploadByteConsumption(resolvedClient, claim)
    )));
    logBackendError('failed_to_prepare_profile_upload_consumption', { error });
    return { ok: false, status: 500, error: 'Failed to verify profile media.' };
  }

  const toStoredMediaUrl = (field: 'avatarUrl' | 'coverUrl'): ProfileFieldUpdate => {
    const value = data[field];
    if (typeof value !== 'string') return value;
    if (keptStoredColumns.includes(field)) return undefined;
    const location = getUserOwnedStoredMediaLocation(value, userId);
    return (location && normalizedUrls.get(`${location.bucket}/${location.filePath}`)) ?? value;
  };

  // Partial PATCH: only the columns the request carried are written. When the
  // row exists, a PostgREST upsert updates exactly the columns in its body, so
  // a field left out keeps its stored value inside the same statement — no
  // read-then-write window in which another client's newer edit is undone.
  const profileValues = {
    id: userId,
    username: data.username ?? validation.existingUsername,
    ...presentColumns({
      display_name: data.displayName,
      bio: data.bio,
      avatar_url: toStoredMediaUrl('avatarUrl'),
      cover_url: toStoredMediaUrl('coverUrl'),
      website_url: data.websiteUrl,
      twitter_handle: data.twitterHandle,
      instagram_handle: data.instagramHandle,
      tiktok_handle: data.tiktokHandle,
      location: data.location,
    }),
  };

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

  const [completed] = await Promise.all([
    completeUploadByteConsumptions(resolvedClient, preservedClaims),
    releaseSupersededProfileUploads(resolvedClient, supersededClaims),
    previousMedia && savedUploads.size > 0
      ? removeReplacedProfileMedia(
        resolvedClient,
        userId,
        previousMedia,
        updatedProfile as Partial<StoredProfileMedia>,
        savedUploads,
      )
      : null,
  ]);
  if (!completed.ok) {
    return { ok: false, status: 500, error: completed.error };
  }

  invalidateFeedCache();

  return {
    ok: true,
    response: buildProfileApiResponse(updatedProfile as ProfileRow, userId),
  };
}
