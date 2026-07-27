import { isAudioModel } from '@/lib/client-generation-models';

export const GENERATION_SHARE_SOURCE_SURFACES = [
  'create-image',
  'create-video',
  'create-motion',
  'my-creations',
  'creator-profile',
  'showcase',
  'detail-page',
  'feed',
] as const;

// Kept as a private alias so the rest of this module reads unchanged.
const SHARE_SOURCE_SURFACES = GENERATION_SHARE_SOURCE_SURFACES;

const SHARE_CHANNELS = ['native-share', 'copy-link'] as const;

export type GenerationShareSourceSurface = (typeof SHARE_SOURCE_SURFACES)[number];
export type GenerationShareChannel = (typeof SHARE_CHANNELS)[number];
export type GenerationShareEventType = 'share_click' | 'share_visit';
type ShowcaseReturnSource = 'community' | 'unlocks' | 'creator' | 'seller' | 'studio' | 'profile' | 'home';

export interface ShowcaseDetailPathOptions {
  from?: ShowcaseReturnSource | string | null;
  returnTo?: string | null;
  section?: 'resources' | string | null;
}

export interface ShowcaseReturnContext {
  source: ShowcaseReturnSource;
  href: string;
  label: string;
}

const SHOWCASE_RETURN_SOURCES: ShowcaseReturnSource[] = [
  'community',
  'unlocks',
  'creator',
  'seller',
  'studio',
  'profile',
  'home',
];

const SHOWCASE_RETURN_LABELS: Record<ShowcaseReturnSource, string> = {
  community: 'Back to Community',
  unlocks: 'Back to Marketplace',
  creator: 'Back to Creator Portfolio',
  seller: 'Back to Seller Dashboard',
  studio: 'Back to My Studio',
  profile: 'Back to Your Profile',
  home: 'Back to Home',
};

const SHOWCASE_RETURN_FALLBACKS: Record<ShowcaseReturnSource, string> = {
  community: '/showcase',
  unlocks: '/marketplace',
  creator: '/showcase',
  seller: '/marketplace/sell',
  studio: '/creations?view=posts',
  profile: '/profile?tab=posts',
  home: '/',
};

export function isGenerationShareSourceSurface(value: string): value is GenerationShareSourceSurface {
  return (SHARE_SOURCE_SURFACES as readonly string[]).includes(value);
}

export function isGenerationShareChannel(value: string): value is GenerationShareChannel {
  return (SHARE_CHANNELS as readonly string[]).includes(value);
}

function normalizeShowcaseReturnSource(value: string | null | undefined): ShowcaseReturnSource | null {
  if (!value) {
    return null;
  }

  return SHOWCASE_RETURN_SOURCES.includes(value as ShowcaseReturnSource)
    ? (value as ShowcaseReturnSource)
    : null;
}

export function getSafeInternalReturnPath(value: string | null | undefined, fallback: string): string {
  const candidate = value?.trim();

  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.startsWith('/\\') ||
    /[\u0000-\u001F\u007F]/.test(candidate)
  ) {
    return fallback;
  }

  return candidate;
}

export function stripShowcaseViewerState(path: string): string {
  const hashIndex = path.indexOf('#');
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : '';
  const pathWithoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = pathWithoutHash.indexOf('?');

  if (queryIndex < 0) {
    return path;
  }

  const pathname = pathWithoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(pathWithoutHash.slice(queryIndex + 1));
  params.delete('post');
  params.delete('media');

  return `${pathname}${params.size > 0 ? `?${params.toString()}` : ''}${hash}`;
}

function inferShowcaseReturnSource(returnTo: string | null | undefined): ShowcaseReturnSource {
  if (!returnTo) {
    return 'community';
  }

  if (returnTo === '/') {
    return 'home';
  }

  if (returnTo.startsWith('/marketplace/sell')) {
    return 'seller';
  }

  if (returnTo.startsWith('/marketplace')) {
    return 'unlocks';
  }

  if (returnTo.startsWith('/creators/')) {
    return 'creator';
  }

  if (returnTo.startsWith('/creations')) {
    return 'studio';
  }

  if (returnTo.startsWith('/profile')) {
    return 'profile';
  }

  return 'community';
}

export function getShowcaseReturnContext({
  from,
  returnTo,
}: {
  from?: string | null;
  returnTo?: string | null;
}): ShowcaseReturnContext {
  const safeReturnTo = stripShowcaseViewerState(getSafeInternalReturnPath(returnTo, ''));
  const source = normalizeShowcaseReturnSource(from) ?? inferShowcaseReturnSource(safeReturnTo);
  const href = safeReturnTo || SHOWCASE_RETURN_FALLBACKS[source];

  return {
    source,
    href,
    label: SHOWCASE_RETURN_LABELS[source],
  };
}

export function getCurrentInternalPath(fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }

  return getSafeInternalReturnPath(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
    fallback
  );
}

export function buildShowcaseDetailPath(generationId: string, options?: ShowcaseDetailPathOptions): string {
  const params = new URLSearchParams();
  const source = normalizeShowcaseReturnSource(options?.from ?? null);
  const returnTo = options?.returnTo
    ? stripShowcaseViewerState(getSafeInternalReturnPath(options.returnTo, ''))
    : '';
  const requestedSection = options?.section?.trim();
  const section = requestedSection === 'resources' ? 'recipe' : requestedSection;

  if (source) {
    params.set('from', source);
  }

  if (returnTo) {
    params.set('returnTo', returnTo);
  }

  return [
    `/showcase/${generationId}`,
    params.size > 0 ? `?${params.toString()}` : '',
    section ? `#${encodeURIComponent(section)}` : '',
  ].join('');
}

export function buildShowcaseDetailUrl(generationId: string, origin: string): string {
  return new URL(buildShowcaseDetailPath(generationId), origin).toString();
}

export function supportsPublicCreationSharing({
  category,
  model,
}: {
  category?: string | null;
  model?: string | null;
}): boolean {
  if (category === 'audio') {
    return false;
  }

  if (model && isAudioModel(model)) {
    return false;
  }

  return true;
}
