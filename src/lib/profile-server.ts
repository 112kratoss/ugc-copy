import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildFallbackUsername,
  isClaimedProfileUsername,
  normalizeUsername,
  sanitizeProfileRecord,
  validateProfileUpdate,
  type ProfileApiResponse,
  type ProfileFieldErrors,
  type ProfileUpdatePayload,
  type ValidatedProfileUpdate,
} from '@/lib/profile';

export const PROFILE_SELECT_FIELDS =
  'id, username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location, credits, promotional_credits, saver_notice_seen_at';

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
  saver_notice_seen_at?: string | null;
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
    .select('id, username, identity_state')
    .eq('username', normalizedUsername)
    .maybeSingle();

  if (error) {
    logBackendError('failed_to_find_shareable_profile', { error: error });
    throw error;
  }

  const profile = data as (ExistingProfileRow & { identity_state?: string | null }) | null;

  // An account being deleted has no page to share: the creator page answers
  // not found from the first step of a deletion, and so does this.
  if (!profile?.username || profile.identity_state === 'deleting') return null;

  return { id: profile.id, username: profile.username };
}

/** A profile row read for an alert, or null when it cannot be read: that costs the name, never the alert. */
async function readAlertProfile(
  adminSupabase: SupabaseClient,
  userId: string,
  columns: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await adminSupabase
      .from('profiles')
      .select(columns)
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      logBackendError('failed_to_load_alert_profile', { error: error });
      return null;
    }
    return (data as Record<string, unknown> | null) ?? null;
  } catch (error) {
    logBackendError('failed_to_load_alert_profile', { error: error });
    return null;
  }
}

/**
 * The handle a follow alert names ("@maya followed you."), or null. Any handle,
 * the generated `creator-xxxxxxxx` one included: follows are public, and the
 * alert opens the follower's page by it.
 */
export async function loadProfileHandle(
  adminSupabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const username = (await readAlertProfile(adminSupabase, userId, 'username'))?.username;
  return typeof username === 'string' ? normalizeUsername(username) : null;
}

/**
 * The handle a save alert may name ("@maya saved your post"), or null to leave
 * the saver "Someone". Saves were private, so only a handle the person chose
 * names them (the `creator-xxxxxxxx` placeholder every account starts with is
 * not one), and only once the account has been told, on record, that creators
 * can see who saved (`profiles.saver_notice_seen_at`, written by
 * `/api/profile/saver-notice`), whatever a save request says.
 */
export async function loadNameableSaverHandle(
  adminSupabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const profile = await readAlertProfile(adminSupabase, userId, 'username, saver_notice_seen_at');
  if (!profile || typeof profile.saver_notice_seen_at !== 'string') return null;

  const username = profile.username;
  return typeof username === 'string' && isClaimedProfileUsername(username)
    ? normalizeUsername(username)
    : null;
}

/** Whether the account has been told that creators can see who saved its posts. */
export async function readSaverNoticeSeen(adminSupabase: SupabaseClient, userId: string) {
  const { data, error } = await adminSupabase
    .from('profiles')
    .select('saver_notice_seen_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return typeof (data as { saver_notice_seen_at?: unknown } | null)?.saver_notice_seen_at === 'string';
}

/** Records that the account has been told; the first telling's time is kept. */
export async function recordSaverNoticeSeen(adminSupabase: SupabaseClient, userId: string) {
  const { error } = await adminSupabase
    .from('profiles')
    .update({ saver_notice_seen_at: new Date().toISOString() })
    .eq('id', userId)
    .is('saver_notice_seen_at', null);

  if (error) throw error;
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
    saverNoticeSeen: typeof profile.saver_notice_seen_at === 'string',
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
