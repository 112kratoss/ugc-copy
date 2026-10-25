import { suggestProfileHandle } from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';
import {
  getCreatorProfileReadiness,
  getReservedProfileUsernameError,
  isClaimedProfileUsername,
  normalizeUsername,
  validateProfileUpdate,
  type ProfileApiResponse,
} from '@/lib/profile';

/**
 * A public post needs a claimed handle and a display name, and every new
 * account starts with neither (`creator-xxxxxxxx`, no name). The composers ask
 * for both beside the publish buttons, filled in from the sign-in, and save
 * them as part of publishing, instead of refusing the post and sending the
 * creator to their profile.
 */
export type PublicIdentityDraft = {
  displayName: string;
  username: string;
};

export type PublicIdentityErrors = Partial<Record<keyof PublicIdentityDraft, string>>;

/** The two profile fields public-publish readiness is judged by. */
export type PublicIdentityProfile = Pick<ProfileApiResponse, 'username' | 'displayName'>;

/** The handle field's rule, in the words Edit profile and onboarding use. */
export const PUBLIC_HANDLE_RULE = '3–24 lowercase letters, numbers, or hyphens.';

type SignedInUser = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
} | null | undefined;

function readSignInName(user: SignedInUser): string {
  const metadata = user?.user_metadata ?? {};
  const name = typeof metadata.full_name === 'string'
    ? metadata.full_name
    : typeof metadata.name === 'string'
      ? metadata.name
      : '';
  return name.trim();
}

/**
 * Where the fields start: what the profile already has, else the name the
 * sign-in gave (or the email's local part, as onboarding does) and a handle
 * made from it, passing over a reserved one.
 */
export function getInitialPublicIdentity(
  profile: PublicIdentityProfile | null,
  user: SignedInUser,
): PublicIdentityDraft {
  const displayName = profile?.displayName?.trim()
    || readSignInName(user)
    || user?.email?.split('@')[0]?.trim()
    || '';
  const ownHandle = isClaimedProfileUsername(profile?.username) ? normalizeUsername(profile?.username) ?? '' : '';
  if (ownHandle) {
    return { displayName, username: ownHandle };
  }
  return {
    displayName,
    username: suggestProfileHandle(displayName, user?.email ?? null, (handle) => !getReservedProfileUsernameError(handle, null)),
  };
}

/** Whether a public post can go out under this profile's name and handle. */
export function isPublicIdentityReady(profile: PublicIdentityProfile | null | undefined): boolean {
  return getCreatorProfileReadiness(profile).publicPublishReady;
}

/** The handle field takes only what a handle can hold, as the app's field does. */
export function normalizeHandleInput(value: string): string {
  return value.toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9-]/g, '').slice(0, 24);
}

/** What can be said about the two fields before asking the server, in the server's own words. */
export function validatePublicIdentity(
  draft: PublicIdentityDraft,
  savedUsername: string | null | undefined,
): PublicIdentityErrors {
  const { fieldErrors } = validateProfileUpdate({ username: draft.username, displayName: draft.displayName });
  const errors: PublicIdentityErrors = {};
  if (fieldErrors.displayName) {
    errors.displayName = fieldErrors.displayName;
  }
  const reservedError = getReservedProfileUsernameError(draft.username, savedUsername);
  if (fieldErrors.username || reservedError) {
    errors.username = fieldErrors.username ?? reservedError ?? undefined;
  }
  return errors;
}

/**
 * The signed-in account's profile, or null when it cannot be read; then the
 * server decides at publish, as it always did. Without a token the session
 * cookie is sent.
 */
export async function loadOwnProfile(
  accessToken: string | null | undefined,
  signal?: AbortSignal,
): Promise<ProfileApiResponse | null> {
  try {
    const response = await fetch('/api/profile', {
      cache: 'no-store',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      signal,
    });
    return response.ok ? await response.json() as ProfileApiResponse : null;
  } catch {
    return null;
  }
}

export type PublicIdentitySaveResult =
  | { ok: true; profile: ProfileApiResponse }
  | { ok: false; errors: PublicIdentityErrors; message: string };

/**
 * Saves only the handle and the name (`PATCH /api/profile` keeps every field
 * it is not sent). A taken handle comes back on its field.
 */
export async function savePublicIdentity(
  draft: PublicIdentityDraft,
  accessToken: string | null | undefined,
): Promise<PublicIdentitySaveResult> {
  try {
    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ username: draft.username.trim(), displayName: draft.displayName.trim() }),
    });
    const data = await response.json().catch(() => null) as
      | (ProfileApiResponse & { error?: string; fieldErrors?: PublicIdentityErrors })
      | null;
    if (response.ok && data) {
      return { ok: true, profile: data };
    }
    return {
      ok: false,
      errors: {
        ...(data?.fieldErrors?.displayName ? { displayName: data.fieldErrors.displayName } : {}),
        ...(data?.fieldErrors?.username ? { username: data.fieldErrors.username } : {}),
      },
      message: data?.error || 'Your name and handle could not be saved. Try again.',
    };
  } catch {
    return { ok: false, errors: {}, message: 'Your name and handle could not be saved. Check your connection and try again.' };
  }
}

/**
 * The step before a public post: the profile is read again first, and when
 * it can already publish (the creator finished it in another tab since the
 * composer read it) nothing is saved, so the composer's older values never
 * replace a handle claimed meanwhile. Otherwise the name and handle are saved.
 */
export async function claimPublicIdentity(
  draft: PublicIdentityDraft,
  accessToken: string | null | undefined,
): Promise<PublicIdentitySaveResult> {
  const current = await loadOwnProfile(accessToken);
  if (current && isPublicIdentityReady(current)) {
    return { ok: true, profile: current };
  }
  return savePublicIdentity(draft, accessToken);
}
