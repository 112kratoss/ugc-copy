import reservedHandlesContract from '../../contracts/reserved-handles-v1.json';
import { siteConfig } from '@/lib/seo';

const USERNAME_PATTERN = /^[a-z0-9-]{3,24}$/;
const GENERATED_USERNAME_PATTERN = /^creator-[a-f0-9]{8}$/;
const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_BIO_LENGTH = 280;
const MAX_WEBSITE_URL_LENGTH = 2048;
const MAX_LOCATION_LENGTH = 80;
// Read from the contract the app's form reads too, so both refuse one list.
const RESERVED_PROFILE_USERNAMES: ReadonlySet<string> = new Set(reservedHandlesContract.reserved);

export const RESERVED_PROFILE_USERNAME_ERROR = 'That handle is reserved.';

/**
 * Each social field stores the handle alone. A pasted profile link is taken
 * only from the platform's own host (with or without `www.`); anything else
 * is refused, so a pill that says Instagram can only ever open Instagram.
 */
const SOCIAL_PROFILE_FIELDS = {
  twitterHandle: { platform: 'X', pattern: /^[A-Za-z0-9_]{1,15}$/, hosts: ['x.com', 'twitter.com'] },
  instagramHandle: { platform: 'Instagram', pattern: /^[A-Za-z0-9._]{1,30}$/, hosts: ['instagram.com'] },
  tiktokHandle: { platform: 'TikTok', pattern: /^[A-Za-z0-9._]{2,24}$/, hosts: ['tiktok.com'] },
} satisfies Record<string, { platform: string; pattern: RegExp; hosts: readonly string[] }>;

export type SocialProfileField = keyof typeof SOCIAL_PROFILE_FIELDS;

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
  /**
   * What the owner's profile libraries hold, counted by the server with the
   * same rules the library lists apply (`owner_profile_counts`). Absent when
   * the count could not be read; a screen then draws its unknown placeholder,
   * never a 0.
   */
  stats?: OwnerProfileStats;
  /** The seller totals the Wallet card and the side menu draw. Absent on a read failure. */
  sales?: OwnerProfileSales;
}

export interface OwnerProfileStats {
  creations: number;
  posts: number;
  archivedPosts: number;
  saved: number;
}

export interface OwnerProfileSales {
  earningsUsdCents: number;
  listingCount: number;
  /** Paid unlocks. A free unlock is not a sale (decision 6, 2026-10-17). */
  salesCount: number;
  freeUnlockCount: number;
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

/**
 * One field of a partial PATCH: `undefined` when the request left the key out
 * (the stored value stays), `null` to clear it, or the new value.
 */
export type ProfileFieldUpdate = string | null | undefined;

interface SanitizedProfileUpdate {
  username: string | null;
  displayName: ProfileFieldUpdate;
  bio: ProfileFieldUpdate;
  avatarUrl: ProfileFieldUpdate;
  coverUrl: ProfileFieldUpdate;
  websiteUrl: ProfileFieldUpdate;
  twitterHandle: ProfileFieldUpdate;
  instagramHandle: ProfileFieldUpdate;
  tiktokHandle: ProfileFieldUpdate;
  location: ProfileFieldUpdate;
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
  missingForSeller: Array<'handle' | 'displayName'>;
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

export function isReservedProfileUsername(value: string | null | undefined): boolean {
  const normalized = normalizeUsername(value);
  return Boolean(normalized && RESERVED_PROFILE_USERNAMES.has(normalized));
}

/**
 * A reserved handle can never be newly claimed, on validate or on save. An
 * account that already holds one keeps it: resending its own stored handle
 * with an unrelated edit is not refused.
 */
export function getReservedProfileUsernameError(
  username: string | null | undefined,
  existingUsername: string | null | undefined
): string | null {
  if (!isReservedProfileUsername(username)) {
    return null;
  }

  return normalizeUsername(username) === normalizeUsername(existingUsername)
    ? null
    : RESERVED_PROFILE_USERNAME_ERROR;
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
  // Selling asks for the same public identity as publishing: a photo is never
  // required to sell (marketplace-trust.ts). The avatar counts only toward a
  // complete profile, the nudge tier.
  const sellerReady = publicPublishReady;
  const profileComplete = publicPublishReady && hasAvatar && hasBio;

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

/**
 * The part of a balance that can buy a creator's recipe. The credit unlock
 * (`unlock_post_resource_bundle_with_credits`) spends only the total less the
 * promotional credits it holds (the welcome grant, referral rewards), so a
 * balance that covers a price can still be refused. Null when the total is
 * unknown.
 */
export function getMarketplaceSpendableCredits(
  totalCredits: number | null,
  promotionalCredits: number | null | undefined,
): number | null {
  if (totalCredits === null) return null;
  return Math.max(0, totalCredits - Math.max(0, promotionalCredits ?? 0));
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
    marketplaceSpendableCredits: getMarketplaceSpendableCredits(totalCredits, promotionalCredits),
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

/**
 * The handle a social field stores, from what someone typed or pasted: a bare
 * handle (one leading `@` dropped), or a link on the platform's own host whose
 * first path segment (minus `@`) is the handle. Null when it is neither.
 */
export function normalizeSocialProfileHandle(field: SocialProfileField, value: string): string | null {
  const { pattern, hosts } = SOCIAL_PROFILE_FIELDS[field];
  const trimmed = value.trim();
  const handle = trimmed.replace(/^@/, '');
  if (pattern.test(handle)) {
    return handle;
  }

  const url = parseSocialProfileLink(trimmed);
  if (!url || !hosts.includes(url.hostname.replace(/^www\./, ''))) {
    return null;
  }

  const linkedHandle = (url.pathname.split('/').find(Boolean) ?? '').replace(/^@/, '');
  return pattern.test(linkedHandle) ? linkedHandle : null;
}

function parseSocialProfileLink(value: string): URL | null {
  // A pasted link often comes without its scheme ("instagram.com/luna").
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

// Partial PATCH: a key the request leaves out stays `undefined`, so the save
// keeps the stored value; `null` or blank text clears it.
function readFieldUpdate(value: unknown): ProfileFieldUpdate {
  return value === undefined ? undefined : normalizeOptionalText(value);
}

function readSocialFieldUpdate(
  field: SocialProfileField,
  value: unknown,
  fieldErrors: ProfileFieldErrors
): ProfileFieldUpdate {
  const text = readFieldUpdate(value);
  if (!text) {
    return text;
  }

  const handle = normalizeSocialProfileHandle(field, text);
  if (!handle) {
    fieldErrors[field] = `Enter your ${SOCIAL_PROFILE_FIELDS[field].platform} username or profile link.`;
  }
  return handle;
}

export function validateProfileUpdate(payload: ProfileUpdatePayload): ValidatedProfileUpdate {
  const fieldErrors: ProfileFieldErrors = {};
  // The username is the one field every save must carry.
  const username = normalizeUsername(
    typeof payload.username === 'string' || payload.username == null
      ? (payload.username as string | null | undefined)
      : undefined
  );
  const displayName = readFieldUpdate(payload.displayName);
  const bio = readFieldUpdate(payload.bio);
  const avatarUrl = readFieldUpdate(payload.avatarUrl);
  const coverUrl = readFieldUpdate(payload.coverUrl);
  const websiteUrl = readFieldUpdate(payload.websiteUrl);
  const twitterHandle = readSocialFieldUpdate('twitterHandle', payload.twitterHandle, fieldErrors);
  const instagramHandle = readSocialFieldUpdate('instagramHandle', payload.instagramHandle, fieldErrors);
  const tiktokHandle = readSocialFieldUpdate('tiktokHandle', payload.tiktokHandle, fieldErrors);
  const location = readFieldUpdate(payload.location);

  if (!username) {
    fieldErrors.username = 'Choose a username to publish your creator profile.';
  } else if (!USERNAME_PATTERN.test(username)) {
    fieldErrors.username = 'Use 3-24 lowercase letters, numbers, or hyphens.';
  } else if (GENERATED_USERNAME_PATTERN.test(username)) {
    fieldErrors.username = 'Choose a custom handle instead of the reserved creator-xxxxxxxx format.';
  }

  // Required like the username above: every surface that renders a creator
  // falls back to the handle when this is blank, so a profile without one
  // reads as half-finished. A save may leave it out to keep the stored name,
  // but never clear it. Bio stays optional.
  if (displayName !== undefined) {
    if (!displayName) {
      fieldErrors.displayName = 'Add a display name for your public profile.';
    } else if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      fieldErrors.displayName = `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
    }
  }

  if (bio && bio.length > MAX_BIO_LENGTH) {
    fieldErrors.bio = `Bio must be ${MAX_BIO_LENGTH} characters or fewer.`;
  }

  if (avatarUrl) {
    try {
      const url = new URL(avatarUrl);
      if (!isAllowedProfileMediaUrl(url)) {
        fieldErrors.avatarUrl = `Use an HTTPS avatar from ${siteConfig.name} or your connected sign-in provider.`;
      }
    } catch {
      fieldErrors.avatarUrl = 'Enter a valid avatar URL.';
    }
  }

  if (coverUrl) {
    try {
      const url = new URL(coverUrl);
      if (!isAllowedProfileMediaUrl(url)) {
        fieldErrors.coverUrl = `Use an HTTPS cover image uploaded through ${siteConfig.name}.`;
      }
    } catch {
      fieldErrors.coverUrl = 'Enter a valid cover URL.';
    }
  }

  if (websiteUrl && websiteUrl.length > MAX_WEBSITE_URL_LENGTH) {
    fieldErrors.websiteUrl = `Website URL must be ${MAX_WEBSITE_URL_LENGTH.toLocaleString('en-US')} characters or fewer.`;
  } else if (websiteUrl) {
    try {
      const url = new URL(websiteUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fieldErrors.websiteUrl = 'Website URL must start with http:// or https://.';
      }
    } catch {
      fieldErrors.websiteUrl = 'Enter a valid website URL.';
    }
  }

  if (location && location.length > MAX_LOCATION_LENGTH) {
    fieldErrors.location = `Location must be ${MAX_LOCATION_LENGTH} characters or fewer.`;
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

function configuredHostname(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedProfileMediaUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;

  // Development and unit-test fixtures can use arbitrary HTTPS origins.
  if (process.env.NODE_ENV !== 'production') return true;

  const hostname = url.hostname.toLowerCase();
  const allowedHosts = new Set([
    'magicbooklet.com',
    configuredHostname(process.env.NEXT_PUBLIC_SITE_URL),
    configuredHostname(process.env.NEXT_PUBLIC_SUPABASE_URL),
  ].filter((value): value is string => Boolean(value)));

  return allowedHosts.has(hostname)
    || hostname.endsWith('.magicbooklet.com')
    || hostname === 'googleusercontent.com'
    || hostname.endsWith('.googleusercontent.com');
}
