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

export function creatorProfileSocialLinks(profile: CreatorProfileResponse['profile']) {
  return [
    profile.websiteUrl ? { label: 'Website', url: withProtocol(profile.websiteUrl) } : null,
    profile.instagramHandle ? { label: 'Instagram', url: socialUrl('https://instagram.com/', profile.instagramHandle) } : null,
    profile.tiktokHandle ? { label: 'TikTok', url: socialUrl('https://tiktok.com/@', profile.tiktokHandle) } : null,
    profile.twitterHandle ? { label: 'X', url: socialUrl('https://x.com/', profile.twitterHandle) } : null,
  ].filter((link): link is { label: string; url: string } => Boolean(link));
}

function withProtocol(value: string) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function socialUrl(baseUrl: string, value: string) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `${baseUrl}${trimmed.replace(/^@/, '')}`;
}

