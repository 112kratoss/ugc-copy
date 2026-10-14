import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { CreatorProfileResponse, ShowcaseFeedItem } from './types';

export type CreatorProfileTab = 'creations' | 'unlocks' | 'tools';

export const CREATOR_PROFILE_TABS: Array<{ id: CreatorProfileTab; label: string }> = [
  { id: 'creations', label: 'Posts' },
  { id: 'unlocks', label: 'Recipes' },
  { id: 'tools', label: 'Tools' },
];

export function normalizeCreatorProfileTab(value: string | string[] | undefined): CreatorProfileTab {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const tab = rawValue?.toLowerCase();
  return tab === 'unlocks' || tab === 'tools' ? tab : 'creations';
}

export function creatorProfileTabItems(items: ShowcaseFeedItem[], tab: CreatorProfileTab) {
  if (tab === 'unlocks') {
    return items.filter((item) => Boolean(item.asset));
  }

  if (tab === 'tools') {
    return [];
  }

  return items;
}

export function flattenCreatorProfilePages(pages: CreatorProfileResponse[] | undefined) {
  const seen = new Set<string>();
  const items: ShowcaseFeedItem[] = [];

  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

export function getNextCreatorProfileOffset(lastPage: CreatorProfileResponse) {
  if (!lastPage.pageInfo.hasMore) return undefined;
  return typeof lastPage.pageInfo.nextOffset === 'number' ? lastPage.pageInfo.nextOffset : undefined;
}

export function creatorInitial(profile: CreatorProfileResponse['profile']) {
  const seed = profile.displayName.trim() || profile.username.trim() || 'Creator';
  return seed[0]?.toUpperCase() ?? 'C';
}

type SocialProfileRule = {
  field: 'instagramHandle' | 'tiktokHandle' | 'twitterHandle';
  label: string;
  pattern: RegExp;
  hosts: readonly string[];
  profileUrl: (handle: string) => string;
};

/**
 * The server's rules for the three social fields (`src/lib/profile.ts`,
 * decision D4): a handle, or a link on the platform's own host whose first
 * path segment is the handle. Saves since 2026-10-14 store the handle; older
 * rows may still hold a link. A pill is only ever built from a handle, so one
 * that says Instagram opens Instagram. A value that is neither is left out,
 * not shown as a website: the creator never offered it as theirs.
 */
const SOCIAL_PROFILE_RULES: readonly SocialProfileRule[] = [
  {
    field: 'instagramHandle',
    label: 'Instagram',
    pattern: /^[A-Za-z0-9._]{1,30}$/,
    hosts: ['instagram.com'],
    profileUrl: (handle) => `https://instagram.com/${encodeURIComponent(handle)}`,
  },
  {
    field: 'tiktokHandle',
    label: 'TikTok',
    pattern: /^[A-Za-z0-9._]{2,24}$/,
    hosts: ['tiktok.com'],
    profileUrl: (handle) => `https://tiktok.com/@${encodeURIComponent(handle)}`,
  },
  {
    field: 'twitterHandle',
    label: 'X',
    pattern: /^[A-Za-z0-9_]{1,15}$/,
    hosts: ['x.com', 'twitter.com'],
    profileUrl: (handle) => `https://x.com/${encodeURIComponent(handle)}`,
  },
];

export function creatorProfileSocialLinks(profile: CreatorProfileResponse['profile']) {
  const links: Array<{ label: string; url: string }> = [];
  if (profile.websiteUrl) links.push({ label: 'Website', url: withProtocol(profile.websiteUrl) });
  for (const rule of SOCIAL_PROFILE_RULES) {
    const value = profile[rule.field];
    const handle = value ? socialProfileHandle(rule, value) : null;
    if (handle) links.push({ label: rule.label, url: rule.profileUrl(handle) });
  }
  return links;
}

function withProtocol(value: string) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

/**
 * A link's host and path. Read with a pattern rather than `URL`: React
 * Native's `URL` neither lower-cases a host nor refuses a malformed link, so
 * the two runtimes would disagree. The scheme may be left off, as the server
 * allows ("instagram.com/luna").
 */
const SOCIAL_LINK_PATTERN = /^(?:https?:\/\/)?([^/?#\s]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/i;

function socialProfileHandle(rule: SocialProfileRule, value: string): string | null {
  const trimmed = value.trim();
  const handle = trimmed.replace(/^@/, '');
  if (rule.pattern.test(handle)) return handle;

  const link = SOCIAL_LINK_PATTERN.exec(trimmed);
  if (!link || !rule.hosts.includes(link[1].toLowerCase().replace(/^www\./, ''))) return null;
  const linkedHandle = ((link[2] ?? '').split('/').find(Boolean) ?? '').replace(/^@/, '');
  return rule.pattern.test(linkedHandle) ? linkedHandle : null;
}

/** Every cached creator grid (`['creator-profile', 'infinite', <handle as routed>]`). */
const CREATOR_PROFILE_QUERY_ROOT = ['creator-profile'] as const;

/** The page the server answers for a creator the viewer blocked: header and counts, no posts, no Follow. */
export function blockedCreatorProfilePage(page: CreatorProfileResponse): CreatorProfileResponse {
  return {
    ...page,
    items: [],
    pageInfo: { ...page.pageInfo, hasMore: false, nextOffset: null, nextLimit: null },
    viewer: { isOwner: false, isFollowing: false, blockedByViewer: true },
  };
}

/**
 * After a block, each cached grid of that creator becomes the page the server
 * now answers for them: their posts leave the cache, and a screen still
 * drawing the grid (the page being left, or one under a reel) says "You
 * blocked @x". Written rather than removed: a query removed under a mounted
 * screen is built again, and fetched, at that screen's next render.
 */
export function setCachedCreatorProfileBlocked(
  queryClient: Pick<QueryClient, 'setQueriesData'>,
  creatorId: string,
) {
  queryClient.setQueriesData<InfiniteData<CreatorProfileResponse>>(
    { queryKey: CREATOR_PROFILE_QUERY_ROOT },
    (data) => {
      const first = data?.pages[0];
      // `undefined` leaves another creator's grid as it was, its age included.
      if (!data || !first || first.profile.id !== creatorId) return undefined;
      return { pages: [blockedCreatorProfilePage(first)], pageParams: data.pageParams.slice(0, 1) };
    },
  );
}

/**
 * Writes whether the viewer follows a creator into each cached page of that
 * creator's grid, so the page under a reel shows the reel's answer without
 * reading its pages again: invalidating `['creator-profile']` refetched every
 * loaded page of every cached grid (audit 02-8). Grids it does not change are
 * left as they were, their age included.
 */
export function setCachedCreatorProfileFollowing(
  queryClient: Pick<QueryClient, 'setQueriesData'>,
  creatorId: string,
  following: boolean,
) {
  queryClient.setQueriesData<InfiniteData<CreatorProfileResponse>>(
    { queryKey: CREATOR_PROFILE_QUERY_ROOT },
    (data) => {
      if (!data?.pages.some((page) => page.profile.id === creatorId && page.viewer.isFollowing !== following)) {
        return undefined;
      }
      return {
        ...data,
        pages: data.pages.map((page) => (
          page.profile.id === creatorId ? { ...page, viewer: { ...page.viewer, isFollowing: following } } : page
        )),
      };
    },
  );
}

export interface CreatorProfileLoadErrorCopy {
  title: string;
  body: string;
  /** False when asking again cannot change the answer; the way on is Explore. */
  canRetry: boolean;
}

/**
 * A page that could not be drawn, named by its cause. A 404 is a handle that
 * is gone (a creator who blocked the viewer reads the same). A 429 clears with
 * time, so it says to wait rather than to check a connection that works.
 */
export function creatorProfileLoadErrorCopy(error: unknown): CreatorProfileLoadErrorCopy {
  const status = errorStatus(error);
  if (status === 404) {
    return {
      title: 'Creator not found',
      body: 'This profile may have been removed, or the handle may have changed.',
      canRetry: false,
    };
  }
  if (status === 429) {
    return {
      title: 'Could not load creator',
      body: `Too many requests in a short time. ${waitSentence(error)}`,
      canRetry: true,
    };
  }
  return { title: 'Could not load creator', body: 'Check your connection, then try again.', canRetry: true };
}

function errorStatus(error: unknown) {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : null;
}

/** The wait a 429 asked for (`retryAfterSeconds` in its body), in words. */
function waitSentence(error: unknown) {
  const details = (error as { details?: unknown }).details;
  const seconds = details && typeof details === 'object'
    ? Math.ceil(Number((details as { retryAfterSeconds?: unknown }).retryAfterSeconds))
    : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Wait a moment, then try again.';
  if (seconds < 60) return `Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
