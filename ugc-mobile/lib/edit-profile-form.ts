import { ApiError } from './api-client';
import type { ProfileResponse } from './types';

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
export const PROFILE_USERNAME_MAX_LENGTH = 24;
export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 60;
export const PROFILE_BIO_MAX_LENGTH = 280;
/** The server's caps (`src/lib/profile.ts`): a field takes no more than a save keeps. */
export const PROFILE_WEBSITE_MAX_LENGTH = 2048;
export const PROFILE_LOCATION_MAX_LENGTH = 80;

/** Stated wherever the field is, rather than only when it is already wrong. */
export const PROFILE_USERNAME_RULE = '3–24 lowercase letters, numbers, or hyphens.';

/**
 * The handle every account is given at signup (`handle_new_user`). It holds a
 * place and is nobody's public name: the server refuses it on every save.
 */
export const PROFILE_PLACEHOLDER_USERNAME_PATTERN = /^creator-[a-f0-9]{8}$/;
/** Onboarding's words for the same refusal (`app/onboarding.tsx`), so both forms say one thing. */
export const PROFILE_PLACEHOLDER_USERNAME_ERROR = 'Use 3–24 lowercase letters, numbers, or hyphens for your handle.';

/**
 * Handles no account may newly claim (D3). The server reads
 * `contracts/reserved-handles-v1.json`; Metro cannot load a file from outside
 * the app, so this is a copy, and `edit-profile-form.test.ts` holds it to the
 * contract.
 */
export const RESERVED_PROFILE_USERNAMES: readonly string[] = [
  'admin',
  'administrator',
  'support',
  'help',
  'magicbooklet',
  'official',
  'staff',
  'team',
  'moderator',
  'mod',
  'root',
  'system',
  'api',
  'www',
  'mail',
  'security',
  'legal',
  'billing',
  'privacy',
  'terms',
  'about',
  'contact',
  'login',
  'signup',
  'settings',
  'profile',
  'creators',
  'explore',
  'showcase',
  'marketplace',
  'pricing',
  'invite',
  'null',
  'undefined',
];
export const RESERVED_PROFILE_USERNAME_ERROR = 'That handle is reserved.';

/**
 * Whether a stored handle is one the person chose. The signup placeholder has a
 * page, but nobody should be sent to it: a link shared from it stops working
 * once a handle is claimed. Mirrors `isClaimedProfileUsername` in
 * `src/lib/profile.ts`, which gates the web's View public and Share.
 */
export function isClaimedProfileUsername(value: string | null | undefined): boolean {
  const username = value?.trim().replace(/^@+/, '').toLowerCase();
  return Boolean(
    username
      && PROFILE_USERNAME_PATTERN.test(username)
      && !PROFILE_PLACEHOLDER_USERNAME_PATTERN.test(username)
  );
}

/** The editor's text, one string per field; an empty string is an empty field. */
export interface EditProfileFormValues {
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  websiteUrl: string;
  location: string;
  twitterHandle: string;
  instagramHandle: string;
  tiktokHandle: string;
}

export const EMPTY_EDIT_PROFILE_FORM: EditProfileFormValues = {
  username: '',
  displayName: '',
  bio: '',
  avatarUrl: '',
  coverUrl: '',
  websiteUrl: '',
  location: '',
  twitterHandle: '',
  instagramHandle: '',
  tiktokHandle: '',
};

/**
 * The form a stored profile opens as. A placeholder handle opens as an empty
 * field, as onboarding opens it: it is not a name to keep, and the field then
 * asks for one before a save uploads anything.
 */
export function editProfileFormFromProfile(profile: ProfileResponse): EditProfileFormValues {
  const username = profile.username ?? profile.suggestedUsername ?? '';
  return {
    username: PROFILE_PLACEHOLDER_USERNAME_PATTERN.test(username) ? '' : username,
    displayName: profile.displayName ?? '',
    bio: profile.bio ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    coverUrl: profile.coverUrl ?? '',
    websiteUrl: profile.websiteUrl ?? '',
    location: profile.location ?? '',
    twitterHandle: profile.twitterHandle ?? '',
    instagramHandle: profile.instagramHandle ?? '',
    tiktokHandle: profile.tiktokHandle ?? '',
  };
}

export type EditProfileFormSnapshot = Partial<Record<keyof EditProfileFormValues, string | null>>;

const EDIT_PROFILE_FORM_FIELDS = Object.keys(EMPTY_EDIT_PROFILE_FORM) as Array<keyof EditProfileFormValues>;

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

  return EDIT_PROFILE_FORM_FIELDS.some((field) => cleanField(current[field]) !== cleanField(initial[field]));
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

/** The fields typed into; the two photos are picked. */
export type EditProfileField =
  | 'username'
  | 'displayName'
  | 'bio'
  | 'websiteUrl'
  | 'location'
  | 'twitterHandle'
  | 'instagramHandle'
  | 'tiktokHandle';
export type EditProfileFieldErrors = Partial<Record<EditProfileField | 'avatarUrl' | 'coverUrl', string>>;

const EDIT_PROFILE_TEXT_FIELDS: readonly EditProfileField[] = [
  'username',
  'displayName',
  'bio',
  'websiteUrl',
  'location',
  'twitterHandle',
  'instagramHandle',
  'tiktokHandle',
];

/**
 * What the form can say about a handle without asking the server: the signup
 * placeholder, and the reserved list (D3, "before the live check"). Neither
 * costs a round trip. A reserved handle the account already holds stays its
 * own, as the server keeps it.
 */
export function readLocalUsernameRejection(value: string, savedUsername?: string | null): string | null {
  const username = normalizeUsername(value);
  if (!username || !PROFILE_USERNAME_PATTERN.test(username)) return null;
  if (PROFILE_PLACEHOLDER_USERNAME_PATTERN.test(username)) return PROFILE_PLACEHOLDER_USERNAME_ERROR;
  if (RESERVED_PROFILE_USERNAMES.includes(username) && username !== normalizeUsername(savedUsername ?? '')) {
    return RESERVED_PROFILE_USERNAME_ERROR;
  }
  return null;
}

/**
 * One field's verdict. Used by the blur handler and by the save path, so the
 * two can never disagree about what is wrong.
 */
export function validateProfileField(
  field: EditProfileField,
  value: string,
  { savedUsername }: { savedUsername?: string | null } = {},
): string | undefined {
  if (field === 'username') {
    const username = normalizeUsername(value);
    if (!username) return 'Choose a username for your profile.';
    if (!PROFILE_USERNAME_PATTERN.test(username)) return `Use ${PROFILE_USERNAME_RULE.toLowerCase()}`;
    return readLocalUsernameRejection(username, savedUsername) ?? undefined;
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

  if (field === 'bio') {
    return value.trim().length > PROFILE_BIO_MAX_LENGTH
      ? `Bio must be ${PROFILE_BIO_MAX_LENGTH} characters or fewer.`
      : undefined;
  }

  if (field === 'websiteUrl') {
    const website = value.trim();
    if (!website) return undefined;
    if (website.length > PROFILE_WEBSITE_MAX_LENGTH) return 'Website URL must be 2,048 characters or fewer.';
    // The server parses the link. A missing scheme is the slip a phone keyboard
    // invites, and every link the server keeps starts with one of these two.
    return /^https?:/i.test(website) ? undefined : 'Website URL must start with http:// or https://.';
  }

  if (field === 'location') {
    return value.trim().length > PROFILE_LOCATION_MAX_LENGTH
      ? `Location must be ${PROFILE_LOCATION_MAX_LENGTH} characters or fewer.`
      : undefined;
  }

  // X, Instagram and TikTok take a handle or the platform's own profile link
  // (D4). That rule is the server's, and a save asks it before any photo uploads.
  return undefined;
}

export function validateProfileForm(
  form: Pick<EditProfileFormValues, 'username' | 'displayName' | 'bio'> & Partial<EditProfileFormValues>,
  context: { savedUsername?: string | null } = {},
) {
  const errors: EditProfileFieldErrors = {};
  for (const field of EDIT_PROFILE_TEXT_FIELDS) {
    const error = validateProfileField(field, form[field] ?? '', context);
    if (error) errors[field] = error;
  }
  return errors;
}

/** What `PATCH /api/profile` is sent. */
export type ProfileUpdateBody = Partial<Pick<ProfileResponse, keyof EditProfileFormValues>>;

const PROFILE_UPDATE_TEXT_FIELDS = [
  'displayName',
  'bio',
  'websiteUrl',
  'location',
  'twitterHandle',
  'instagramHandle',
  'tiktokHandle',
] as const satisfies ReadonlyArray<keyof EditProfileFormValues>;

/**
 * A save's body. The PATCH is partial (a key left out keeps the stored value,
 * `null` clears it), so the body carries the handle every save must, and only
 * the fields edited since the form opened. A field this screen did not touch
 * can then never write its stale copy over a newer edit made on the web.
 */
export function buildProfileUpdateBody({
  current,
  initial,
  avatarUrl,
  coverUrl,
}: {
  current: EditProfileFormValues;
  initial: EditProfileFormValues;
  /** A photo uploaded for this save; without one, the stored photo stays. */
  avatarUrl?: string | null;
  coverUrl?: string | null;
}): ProfileUpdateBody {
  const body: ProfileUpdateBody = { username: normalizeUsername(current.username) };
  for (const field of PROFILE_UPDATE_TEXT_FIELDS) {
    if (cleanField(current[field]) === cleanField(initial[field])) continue;
    const value = current[field].trim();
    // The server refuses a null display name; the form never saves a blank one.
    if (field === 'displayName' && !value) continue;
    body[field] = value || null;
  }
  if (avatarUrl) body.avatarUrl = avatarUrl;
  if (coverUrl) body.coverUrl = coverUrl;
  return body;
}

/**
 * Onboarding's body: the handle and the name its identity step claims, and
 * nothing else. An echo of the copy read at the start of the step could write
 * over a newer edit, and a `null` in it would clear the field.
 */
export function buildIdentityClaimBody(username: string, displayName: string): ProfileUpdateBody {
  return { username, displayName };
}

/**
 * Whether a refused profile request was the server's verdict on the fields (a
 * 400 or a 409), rather than a request that failed and said nothing about them.
 */
export function isProfileFieldVerdict(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 400 || error.status === 409);
}

/** A save the form refused itself, before any request: `validateProfileForm`'s verdicts. */
export class EditProfileValidationError extends Error {
  readonly fieldErrors: EditProfileFieldErrors;

  constructor(fieldErrors: EditProfileFieldErrors) {
    super('Fix the highlighted profile fields.');
    this.name = 'EditProfileValidationError';
    this.fieldErrors = fieldErrors;
  }
}

/** Edit profile's fields from the top of the form down: the two photos, then the text fields as drawn. */
const EDIT_PROFILE_FIELDS_DOWN_THE_FORM: readonly (keyof EditProfileFieldErrors)[] = [
  'coverUrl',
  'avatarUrl',
  'displayName',
  'username',
  'bio',
  'websiteUrl',
  'location',
  'twitterHandle',
  'instagramHandle',
  'tiktokHandle',
];

export interface EditProfileSaveRefusal {
  /** The verdicts on fields the form draws, each said under its own field. */
  fieldErrors: EditProfileFieldErrors;
  /** The first refused field down the form, to bring into view; null when the refusal names none. */
  firstField: keyof EditProfileFieldErrors | null;
  /** For the block above the form: only a refusal that names no field the form draws. */
  message: string | null;
}

/**
 * Where a failed save is said. A verdict on a field goes under that field and
 * nowhere else: the block above the form used to repeat it and kept saying a
 * handle was taken after the field had moved on to one the live check called
 * available. The block keeps what no field can hold, such as a request that
 * failed offline or an upload that did not finish.
 */
export function readProfileSaveRefusal(error: unknown): EditProfileSaveRefusal {
  let verdicts: Partial<Record<string, unknown>> = {};
  if (error instanceof EditProfileValidationError) {
    verdicts = error.fieldErrors;
  } else if (error instanceof ApiError) {
    const details = error.details as { fieldErrors?: Partial<Record<string, unknown>> } | undefined;
    // A 409 can arrive without field errors; it is still about the handle.
    const username = readUsernameRejection(error);
    verdicts = { ...details?.fieldErrors, ...(username ? { username } : {}) };
  }

  const fieldErrors: EditProfileFieldErrors = {};
  for (const field of EDIT_PROFILE_FIELDS_DOWN_THE_FORM) {
    const verdict = verdicts[field];
    if (typeof verdict === 'string' && verdict) fieldErrors[field] = verdict;
  }
  const firstField = EDIT_PROFILE_FIELDS_DOWN_THE_FORM.find((field) => fieldErrors[field]) ?? null;
  return {
    fieldErrors,
    firstField,
    message: firstField ? null : error instanceof Error ? error.message : 'Profile could not be saved.',
  };
}

/**
 * How a profile photo is cropped as it is picked: the system crop's ratio, or
 * null to take the photo whole. The avatar is cropped square everywhere. On
 * iOS the system crop is always square (`aspect` is Android-only in
 * expo-image-picker), which cut a cover to a square the wide strip then showed
 * a quarter of; so iOS takes the cover whole and the server frames it at 40:9.
 * Android keeps its own 16:9 crop.
 */
export function profilePhotoCropAspect(role: 'avatar' | 'cover', platformOS: string): [number, number] | null {
  if (role === 'avatar') return [1, 1];
  return platformOS === 'ios' ? null : [16, 9];
}

/** JPEG quality for a cropped photo. */
export const PROFILE_PHOTO_QUALITY = 0.9;
/**
 * JPEG quality for a cover taken whole. The crop used to shrink the photo; a
 * whole 24 MP camera photo at 0.9 can run past the 5 MB profile upload cap, and
 * a cover is drawn 1600 px wide at most.
 */
export const PROFILE_UNCROPPED_COVER_QUALITY = 0.6;

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
  // Answered on the phone, before the live check (D3).
  if (readLocalUsernameRejection(username, savedUsername)) return false;
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
