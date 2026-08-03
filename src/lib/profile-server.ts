import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildFallbackUsername,
  normalizeUsername,
  sanitizeProfileRecord,
  validateProfileUpdate,
  type ProfileApiResponse,
  type ProfileFieldErrors,
  type ProfileUpdatePayload,
  type ValidatedProfileUpdate,
} from '@/lib/profile';

export const PROFILE_SELECT_FIELDS =
  'id, username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location, credits, promotional_credits';

export interface ProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  website_url: string | null;
  twitter_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  location: string | null;
  credits: number | null;
  promotional_credits?: number | null;
}

interface ExistingProfileRow {
  id: string;
  username: string | null;
}

export interface ShareableProfileReference {
  id: string;
  username: string;
}

/**
 * The profile behind a `/creators/<username>` URL, for surfaces that only need
 * to know a share target exists.
 *
 * Deliberately not `getCreatorProfileSummary`: that one is `cache()`-wrapped and
 * builds its own service client, which makes it impossible to inject in a test.
 * This takes the caller's client so the share service stays testable.
 */
export async function findShareableProfileByUsername(
  username: string,
  adminSupabase: SupabaseClient
): Promise<ShareableProfileReference | null> {
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    return null;
  }

  const { data, error } = await adminSupabase
    .from('profiles')
    .select('id, username')
    .eq('username', normalizedUsername)
    .maybeSingle();

  if (error) {
    logBackendError('failed_to_find_shareable_profile', { error: error });
    throw error;
  }

  const profile = data as ExistingProfileRow | null;

  return profile?.username ? { id: profile.id, username: profile.username } : null;
}

interface ProfileValidationSuccess {
  ok: true;
  payload: ValidatedProfileUpdate;
  existingUsername: string | null;
}

interface ProfileValidationFailure {
  ok: false;
  status: number;
  body: {
    error: string;
    fieldErrors?: ProfileFieldErrors;
  };
}

export type ProfileValidationResult = ProfileValidationSuccess | ProfileValidationFailure;

function buildValidationFailure(
  status: number,
  error: string,
  fieldErrors?: ProfileFieldErrors
): ProfileValidationFailure {
  return {
    ok: false,
    status,
    body: {
      error,
      ...(fieldErrors ? { fieldErrors } : {}),
    },
  };
}

export function buildProfileApiResponse(profile: ProfileRow, userId: string): ProfileApiResponse {
  return {
    ...sanitizeProfileRecord(profile),
    suggestedUsername: buildFallbackUsername(userId),
  };
}

export async function validateProfileSubmission(
  adminSupabase: SupabaseClient,
  userId: string,
  rawPayload: ProfileUpdatePayload
): Promise<ProfileValidationResult> {
  const payload = validateProfileUpdate(rawPayload);
  if (Object.keys(payload.fieldErrors).length > 0) {
    return buildValidationFailure(400, 'Please fix the highlighted fields.', payload.fieldErrors);
  }

  const { data: existingProfile, error: existingError } = await adminSupabase
    .from('profiles')
    .select('id, username')
    .eq('id', userId)
    .maybeSingle();

  if (existingError) {
    logBackendError('failed_to_load_current_profile', { error: existingError });
    return buildValidationFailure(500, 'Failed to load profile');
  }

  if (payload.data.username) {
    const { data: duplicateProfile, error: duplicateError } = await adminSupabase
      .from('profiles')
      .select('id')
      .eq('username', payload.data.username)
      .neq('id', userId)
      .maybeSingle();

    if (duplicateError) {
      logBackendError('failed_to_validate_username', { error: duplicateError });
      return buildValidationFailure(500, 'Failed to validate username');
    }

    if (duplicateProfile) {
      return buildValidationFailure(409, 'That username is already taken.', {
        username: 'That username is already taken.',
      });
    }
  }

  return {
    ok: true,
    payload,
    existingUsername: (existingProfile as ExistingProfileRow | null)?.username ?? null,
  };
}
