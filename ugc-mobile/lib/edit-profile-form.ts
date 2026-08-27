import { ApiError } from './api-client';

/**
 * The profile form's field rules, in one place.
 *
 * They used to live twice: `app/onboarding.tsx` claims a display name and a
 * username, and `components/edit-profile-screen.tsx` changes the same two
 * fields later — and only the first one enforced them as you typed. HIG Text
 * fields is specific about when: "when creating a user name or password,
 * validation needs to happen before people switch to another field", and
 * Entering data asks you to "verify values as soon as people enter them — and
 * provide feedback as soon as you detect a problem", because "people can get
 * frustrated when they have to go back and correct mistakes after filling out
 * a lengthy form". On the edit screen the correction came later still: the
 * avatar and cover upload before the profile PATCH, so a username the server
 * refuses was reported after two uploads had already run.
 */

export const PROFILE_USERNAME_PATTERN = /^[a-z0-9-]{3,24}$/;
export const PROFILE_USERNAME_MIN_LENGTH = 3;
export const PROFILE_USERNAME_MAX_LENGTH = 24;
export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 60;
export const PROFILE_BIO_MAX_LENGTH = 280;

/** Stated wherever the field is, rather than only when it is already wrong. */
export const PROFILE_USERNAME_RULE = '3–24 lowercase letters, numbers, or hyphens.';

export interface EditProfileFormSnapshot {
  username?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
}

export function hasEditProfileChanges({
  current,
  initial,
  hasAvatarDraft,
  hasCoverDraft,
}: {
  current: EditProfileFormSnapshot;
  initial: EditProfileFormSnapshot;
  hasAvatarDraft: boolean;
  hasCoverDraft: boolean;
}) {
  if (hasAvatarDraft || hasCoverDraft) return true;

  return (
    cleanField(current.username) !== cleanField(initial.username) ||
    cleanField(current.displayName) !== cleanField(initial.displayName) ||
    cleanField(current.bio) !== cleanField(initial.bio) ||
    cleanField(current.avatarUrl) !== cleanField(initial.avatarUrl) ||
    cleanField(current.coverUrl) !== cleanField(initial.coverUrl)
  );
}

function cleanField(value: string | null | undefined) {
  return value ?? '';
}

/**
 * Keystroke normalisation for the username field, lifted verbatim from the
 * onboarding screen that claims the same handle: lowercase, no leading `@`,
 * nothing outside the allowed set. Entering data prefers a field that cannot
 * take a bad value over one that reports it afterwards, and this is the shape
 * the app already taught people on the way in.
 */
export function normalizeUsernameInput(value: string) {
  return value.toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9-]/g, '');
}

/** The value the API is given, or null when the field is empty. */
export function normalizeUsername(value: string) {
  const normalized = normalizeUsernameInput(value.trim());
  return normalized.length > 0 ? normalized : null;
}

export type EditProfileField = 'username' | 'displayName' | 'bio';
export type EditProfileFieldErrors = Partial<Record<EditProfileField | 'avatarUrl' | 'coverUrl', string>>;

/**
 * One field's verdict. Used by the blur handler and by the save path, so the
 * two can never disagree about what is wrong.
 */
export function validateProfileField(field: EditProfileField, value: string): string | undefined {
  if (field === 'username') {
    const username = normalizeUsername(value);
    if (!username) return 'Choose a username for your profile.';
    if (!PROFILE_USERNAME_PATTERN.test(username)) return `Use ${PROFILE_USERNAME_RULE.toLowerCase()}`;
    return undefined;
  }

  if (field === 'displayName') {
    // Required by the API (`validateProfileUpdate`: "Add a display name for
    // your public profile"), and the screen used to let you blank it, press
    // Save, upload both images and only then be told.
    if (!value.trim()) return 'Add a display name for your public profile.';
    return value.trim().length > PROFILE_DISPLAY_NAME_MAX_LENGTH
      ? `Display name must be ${PROFILE_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`
      : undefined;
  }

  return value.trim().length > PROFILE_BIO_MAX_LENGTH
    ? `Bio must be ${PROFILE_BIO_MAX_LENGTH} characters or fewer.`
    : undefined;
}

export function validateProfileForm(form: { username: string; displayName: string; bio: string }) {
  const errors: EditProfileFieldErrors = {};
  for (const field of ['username', 'displayName', 'bio'] as const) {
    const error = validateProfileField(field, form[field]);
    if (error) errors[field] = error;
  }
  return errors;
}

export type UsernameAvailability = 'idle' | 'checking' | 'available' | 'taken';

/**
 * Whether the availability round trip is worth making.
 *
 * Skipped for a username the person already owns — `/api/profile/validate`
 * would answer "taken" about their own handle — and for one that cannot be
 * valid yet, so the field stays quiet while it is being typed rather than
 * announcing a failure at every character.
 */
export function shouldCheckUsernameAvailability({
  value,
  displayName,
  savedUsername,
}: {
  value: string;
  displayName: string;
  savedUsername?: string | null;
}) {
  const username = normalizeUsername(value);
  if (!username) return false;
  if (!PROFILE_USERNAME_PATTERN.test(username)) return false;
  // The endpoint validates the whole submission, so a blank display name comes
  // back as a 400 that says nothing about the name. Its own field reports that.
  if (!displayName.trim()) return false;
  return username !== normalizeUsername(savedUsername ?? '');
}

/**
 * A failed availability check is not the same as a taken username: offline the
 * request fails, and the endpoint is rate limited (429), in neither case having
 * an opinion about the name. Only a verdict from the server — a rejected
 * submission (400) or a duplicate (409) — is reported and blocks the save;
 * anything else leaves the field alone and lets the save path do the reporting.
 */
export function readUsernameRejection(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 400 && error.status !== 409) return null;
  const details = error.details as { fieldErrors?: { username?: string } } | undefined;
  const fieldError = details?.fieldErrors?.username;
  if (fieldError) return fieldError;
  return error.status === 409 ? (error.message || 'That username is taken.') : null;
}

/**
 * The line under the username field. It always says something — the rule when
 * there is nothing else to report — because Entering data asks you to "be clear
 * about the data you need" rather than only about the data you rejected.
 */
export function usernameHint({
  availability,
  message,
}: {
  availability: UsernameAvailability;
  message?: string | null;
}): { text: string; tone: 'muted' | 'success' | 'danger' } {
  if (availability === 'checking') return { text: 'Checking availability…', tone: 'muted' };
  if (availability === 'available') return { text: message ?? 'This username is available.', tone: 'success' };
  if (availability === 'taken') return { text: message ?? 'That username is taken.', tone: 'danger' };
  return { text: PROFILE_USERNAME_RULE, tone: 'muted' };
}
