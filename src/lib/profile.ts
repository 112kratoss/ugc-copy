const USERNAME_PATTERN = /^[a-z0-9-]{3,24}$/;
const GENERATED_USERNAME_PATTERN = /^creator-[a-f0-9]{8}$/;
const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_BIO_LENGTH = 280;

export interface ProfileFieldErrors {
  username?: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  coverUrl?: string;
  websiteUrl?: string;
  twitterHandle?: string;
  instagramHandle?: string;
  tiktokHandle?: string;
  location?: string;
}

export interface ProfileApiResponse {
  id: string;
  username: string | null;
  suggestedUsername: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  websiteUrl: string | null;
  twitterHandle: string | null;
  instagramHandle: string | null;
  tiktokHandle: string | null;
  location: string | null;
  credits: number | null;
  promotionalCredits?: number | null;
  marketplaceSpendableCredits?: number | null;
}

export interface EditableCreatorProfile {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  websiteUrl: string;
  twitterHandle: string;
  instagramHandle: string;
  tiktokHandle: string;
  location: string;
  credits: number | null;
  promotionalCredits?: number | null;
  marketplaceSpendableCredits?: number | null;
}

export interface ProfileUpdatePayload {
  username?: unknown;
  displayName?: unknown;
  bio?: unknown;
  avatarUrl?: unknown;
  coverUrl?: unknown;
  websiteUrl?: unknown;
  twitterHandle?: unknown;
  instagramHandle?: unknown;
  tiktokHandle?: unknown;
  location?: unknown;
}

interface SanitizedProfileUpdate {
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  websiteUrl: string | null;
  twitterHandle: string | null;
  instagramHandle: string | null;
  tiktokHandle: string | null;
  location: string | null;
}

export interface ValidatedProfileUpdate {
  data: SanitizedProfileUpdate;
  fieldErrors: ProfileFieldErrors;
}

export interface CreatorProfileReadinessInput {
  username?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
}

export interface CreatorProfileReadiness {
  hasClaimedHandle: boolean;
  hasDisplayName: boolean;
  hasBio: boolean;
  hasAvatar: boolean;
  hasCover: boolean;
  publicPublishReady: boolean;
  sellerReady: boolean;
  profileComplete: boolean;
  missingForPublicPublish: Array<'handle' | 'displayName'>;
  missingForSeller: Array<'handle' | 'displayName' | 'avatar'>;
  missingForCompleteProfile: Array<'handle' | 'displayName' | 'avatar' | 'bio'>;
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

export function isGeneratedProfileUsername(value: string | null | undefined): boolean {
  const normalized = normalizeUsername(value);
  return Boolean(normalized && GENERATED_USERNAME_PATTERN.test(normalized));
}

export function isClaimedProfileUsername(value: string | null | undefined): boolean {
  const normalized = normalizeUsername(value);
  return Boolean(
    normalized
      && USERNAME_PATTERN.test(normalized)
      && !GENERATED_USERNAME_PATTERN.test(normalized)
  );
}

export function getCreatorProfileReadiness(
  profile: CreatorProfileReadinessInput | null | undefined
): CreatorProfileReadiness {
  const hasClaimedHandle = isClaimedProfileUsername(profile?.username);
  const hasDisplayName = Boolean(profile?.displayName?.trim());
  const hasBio = Boolean(profile?.bio?.trim());
  const hasAvatar = Boolean(profile?.avatarUrl?.trim());
  const hasCover = Boolean(profile?.coverUrl?.trim());
  const publicPublishReady = hasClaimedHandle && hasDisplayName;
  const sellerReady = publicPublishReady && hasAvatar;
  const profileComplete = sellerReady && hasBio;

  return {
    hasClaimedHandle,
    hasDisplayName,
    hasBio,
    hasAvatar,
    hasCover,
    publicPublishReady,
    sellerReady,
    profileComplete,
    missingForPublicPublish: [
      ...(!hasClaimedHandle ? ['handle' as const] : []),
      ...(!hasDisplayName ? ['displayName' as const] : []),
    ],
    missingForSeller: [
      ...(!hasClaimedHandle ? ['handle' as const] : []),
      ...(!hasDisplayName ? ['displayName' as const] : []),
      ...(!hasAvatar ? ['avatar' as const] : []),
    ],
    missingForCompleteProfile: [
      ...(!hasClaimedHandle ? ['handle' as const] : []),
      ...(!hasDisplayName ? ['displayName' as const] : []),
      ...(!hasAvatar ? ['avatar' as const] : []),
      ...(!hasBio ? ['bio' as const] : []),
    ],
  };
}

export function getSafeProfileNextPath(
  value: string | null | undefined,
  fallback = '/creations'
): string {
  const rawCandidate = value?.trim();
  if (!rawCandidate) {
    return fallback;
  }

  let candidate = rawCandidate;
  if (!candidate.startsWith('/')) {
    try {
      candidate = decodeURIComponent(rawCandidate);
    } catch {
      return fallback;
    }
  }

  let safetyCandidate = candidate;
  try {
    safetyCandidate = decodeURIComponent(candidate);
  } catch {
    // Preserve valid internal URLs that contain a literal percent sign while
    // still applying the non-decoded safety checks below.
  }

  if (
    !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001F\u007F]/.test(candidate)
    || safetyCandidate.startsWith('//')
    || safetyCandidate.includes('\\')
    || /[\u0000-\u001F\u007F]/.test(safetyCandidate)
  ) {
    return fallback;
  }

  return candidate;
}

export function buildCreatorProfilePath(username: string): string {
  const normalizedUsername = normalizeUsername(username);
  return normalizedUsername ? `/creators/${normalizedUsername}` : '/showcase';
}

export function buildCreatorProfileUrl(username: string, origin: string): string {
  return new URL(buildCreatorProfilePath(username), origin).toString();
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
    username: profile.username ?? profile.suggestedUsername,
    displayName: profile.displayName ?? '',
    bio: profile.bio ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    coverUrl: profile.coverUrl ?? '',
    websiteUrl: profile.websiteUrl ?? '',
    twitterHandle: profile.twitterHandle ?? '',
    instagramHandle: profile.instagramHandle ?? '',
    tiktokHandle: profile.tiktokHandle ?? '',
    location: profile.location ?? '',
    credits: profile.credits,
    promotionalCredits: profile.promotionalCredits ?? 0,
    marketplaceSpendableCredits: profile.marketplaceSpendableCredits ?? profile.credits,
  };
}

export function sanitizeProfileRecord(record: {
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
}): ProfileApiResponse {
  const totalCredits = typeof record.credits === 'number' ? record.credits : null;
  const promotionalCredits = Math.max(0, record.promotional_credits ?? 0);

  return {
    id: record.id,
    username: record.username,
    suggestedUsername: '',
    displayName: record.display_name,
    bio: record.bio,
    avatarUrl: record.avatar_url,
    coverUrl: record.cover_url,
    websiteUrl: record.website_url,
    twitterHandle: record.twitter_handle,
    instagramHandle: record.instagram_handle,
    tiktokHandle: record.tiktok_handle,
    location: record.location,
    credits: totalCredits,
    promotionalCredits,
    marketplaceSpendableCredits: totalCredits === null
      ? null
      : Math.max(0, totalCredits - promotionalCredits),
  };
}

export function getCreatorDisplayName(profile: {
  displayName?: string | null;
  username?: string | null;
  name?: string | null;
  email?: string | null;
}): string {
  const displayName = profile.displayName ?? profile.name;
  if (displayName && displayName.trim().length > 0) {
    return displayName.trim();
  }

  if (profile.username && profile.username.trim().length > 0) {
    return profile.username.trim();
  }

  if (profile.email && profile.email.trim().length > 0) {
    return profile.email.split('@')[0]?.trim() || 'Creator';
  }

  return 'Creator';
}

export function getUserInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'U'
  );
}

export function getAuthAvatarUrl(
  userMetadata: Record<string, unknown> | null | undefined
): string | null {
  if (!userMetadata) {
    return null;
  }

  const candidates = [
    userMetadata.avatar_url,
    userMetadata.picture,
    userMetadata.photoURL,
    userMetadata.image,
    userMetadata.avatar,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
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
  const coverUrl = normalizeOptionalText(payload.coverUrl);
  const websiteUrl = normalizeOptionalText(payload.websiteUrl);
  const twitterHandle = normalizeOptionalText(payload.twitterHandle)?.replace(/^@/, '') ?? null;
  const instagramHandle = normalizeOptionalText(payload.instagramHandle)?.replace(/^@/, '') ?? null;
  const tiktokHandle = normalizeOptionalText(payload.tiktokHandle)?.replace(/^@/, '') ?? null;
  const location = normalizeOptionalText(payload.location);

  if (!username) {
    fieldErrors.username = 'Choose a username to publish your creator profile.';
  } else if (!USERNAME_PATTERN.test(username)) {
    fieldErrors.username = 'Use 3-24 lowercase letters, numbers, or hyphens.';
  } else if (GENERATED_USERNAME_PATTERN.test(username)) {
    fieldErrors.username = 'Choose a custom handle instead of the reserved creator-xxxxxxxx format.';
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

  if (coverUrl) {
    try {
      const url = new URL(coverUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fieldErrors.coverUrl = 'Cover URL must start with http:// or https://.';
      }
    } catch {
      fieldErrors.coverUrl = 'Enter a valid cover URL.';
    }
  }

  if (websiteUrl) {
    try {
      const url = new URL(websiteUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fieldErrors.websiteUrl = 'Website URL must start with http:// or https://.';
      }
    } catch {
      fieldErrors.websiteUrl = 'Enter a valid website URL.';
    }
  }

  return {
    data: {
      username,
      displayName,
      bio,
      avatarUrl,
      coverUrl,
      websiteUrl,
      twitterHandle,
      instagramHandle,
      tiktokHandle,
      location,
    },
    fieldErrors,
  };
}
