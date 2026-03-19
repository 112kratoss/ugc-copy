export const USERNAME_PATTERN = /^[a-z0-9-]{3,24}$/;
const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_BIO_LENGTH = 280;

export interface ProfileFieldErrors {
  username?: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
}

export interface ProfileApiResponse {
  id: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  credits: number | null;
}

export interface EditableCreatorProfile {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  credits: number | null;
}

export interface ProfileUpdatePayload {
  username?: unknown;
  displayName?: unknown;
  bio?: unknown;
  avatarUrl?: unknown;
}

export interface SanitizedProfileUpdate {
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

export interface ValidatedProfileUpdate {
  data: SanitizedProfileUpdate;
  fieldErrors: ProfileFieldErrors;
}

export function buildFallbackUsername(userId: string): string {
  return `creator-${userId.replace(/-/g, '').slice(0, 8).toLowerCase()}`;
}

export function normalizeUsername(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/^@+/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toEditableCreatorProfile(profile: ProfileApiResponse): EditableCreatorProfile {
  return {
    id: profile.id,
    username: profile.username ?? '',
    displayName: profile.displayName ?? '',
    bio: profile.bio ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    credits: profile.credits,
  };
}

export function sanitizeProfileRecord(record: {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  credits: number | null;
}): ProfileApiResponse {
  return {
    id: record.id,
    username: record.username,
    displayName: record.display_name,
    bio: record.bio,
    avatarUrl: record.avatar_url,
    credits: record.credits,
  };
}

export function getCreatorDisplayName(profile: {
  displayName?: string | null;
  username?: string | null;
  name?: string | null;
}): string {
  const displayName = profile.displayName ?? profile.name;
  if (displayName && displayName.trim().length > 0) {
    return displayName.trim();
  }

  if (profile.username && profile.username.trim().length > 0) {
    return profile.username.trim();
  }

  return 'Anonymous';
}

export function validateProfileUpdate(payload: ProfileUpdatePayload): ValidatedProfileUpdate {
  const fieldErrors: ProfileFieldErrors = {};
  const username = normalizeUsername(
    typeof payload.username === 'string' || payload.username == null
      ? (payload.username as string | null | undefined)
      : undefined
  );
  const displayName = normalizeOptionalText(payload.displayName);
  const bio = normalizeOptionalText(payload.bio);
  const avatarUrl = normalizeOptionalText(payload.avatarUrl);

  if (!username) {
    fieldErrors.username = 'Choose a username to publish your creator profile.';
  } else if (!USERNAME_PATTERN.test(username)) {
    fieldErrors.username = 'Use 3-24 lowercase letters, numbers, or hyphens.';
  }

  if (displayName && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    fieldErrors.displayName = `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
  }

  if (bio && bio.length > MAX_BIO_LENGTH) {
    fieldErrors.bio = `Bio must be ${MAX_BIO_LENGTH} characters or fewer.`;
  }

  if (avatarUrl) {
    try {
      const url = new URL(avatarUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fieldErrors.avatarUrl = 'Avatar URL must start with http:// or https://.';
      }
    } catch {
      fieldErrors.avatarUrl = 'Enter a valid avatar URL.';
    }
  }

  return {
    data: {
      username,
      displayName,
      bio,
      avatarUrl,
    },
    fieldErrors,
  };
}
