import { suggestProfileHandle } from '@/lib/post-publish-policy/post-publish-policy';
import {
  isClaimedProfileUsername,
  normalizeUsername,
  readLocalUsernameRejection,
  readUsernameRejection,
  validateProfileField,
} from '@/lib/edit-profile-form';
import { ApiError } from '@/lib/api-client';
import type { ProfileResponse } from '@/lib/types';

/**
 * A public post needs a claimed handle and a display name, and a new account
 * has neither (`creator-xxxxxxxx`, no name). The composer asks for both on its
 * last step, filled in from the sign-in, and saves them before the post, as the
 * web composers do (`src/lib/public-identity.ts`), where the server used to
 * refuse the post and send the creator to their profile.
 */
export type PublicIdentityDraft = {
  displayName: string;
  username: string;
};

export type PublicIdentityErrors = Partial<Record<keyof PublicIdentityDraft, string>>;

type SignedInUser = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
} | null | undefined;

/** The server's public gate (`getCreatorProfileReadiness`): a claimed handle and a display name. */
export function isPublicIdentityReady(profile: Pick<ProfileResponse, 'username' | 'displayName'> | null | undefined): boolean {
  return Boolean(profile && isClaimedProfileUsername(profile.username) && profile.displayName?.trim());
}

function readSignInName(metadata: Record<string, unknown> | null | undefined): string {
  const candidate = metadata?.full_name ?? metadata?.name;
  return typeof candidate === 'string' ? candidate.trim() : '';
}

/**
 * Where the fields start: what the profile already has, else the name the
 * sign-in gave and a handle made from it. A reserved handle is left for the
 * creator to choose.
 */
export function getInitialPublicIdentity(
  profile: Pick<ProfileResponse, 'username' | 'displayName'> | null | undefined,
  user: SignedInUser,
): PublicIdentityDraft {
  const displayName = profile?.displayName?.trim() || readSignInName(user?.user_metadata);
  if (isClaimedProfileUsername(profile?.username)) {
    return { displayName, username: normalizeUsername(profile?.username ?? '') ?? '' };
  }
  const suggested = suggestProfileHandle(displayName, user?.email ?? null);
  return { displayName, username: suggested && !readLocalUsernameRejection(suggested) ? suggested : '' };
}

/** The profile editor's own verdicts on the two fields, so both forms say one thing. */
export function validatePublicIdentity(
  draft: PublicIdentityDraft,
  savedUsername: string | null | undefined,
): PublicIdentityErrors {
  const errors: PublicIdentityErrors = {};
  const displayName = validateProfileField('displayName', draft.displayName);
  if (displayName) errors.displayName = displayName;
  const username = validateProfileField('username', draft.username, { savedUsername });
  if (username) errors.username = username;
  return errors;
}

/**
 * What a failed save says, and on which field: a taken or refused handle on
 * the handle, anything else (offline, rate limited) above the fields.
 */
export function readPublicIdentitySaveError(error: unknown): { errors: PublicIdentityErrors; message: string } {
  const username = readUsernameRejection(error);
  if (username) {
    return { errors: { username }, message: username };
  }
  const details = error instanceof ApiError
    ? (error.details as { fieldErrors?: { displayName?: string } } | undefined)
    : undefined;
  if (details?.fieldErrors?.displayName) {
    return { errors: { displayName: details.fieldErrors.displayName }, message: details.fieldErrors.displayName };
  }
  return { errors: {}, message: 'Your name and handle could not be saved. Check your connection and try again.' };
}
