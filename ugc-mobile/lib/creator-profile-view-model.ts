import { hasShowcaseVideoWithoutPreview } from './showcase-media';
import type { CreatorProfileResponse, ShowcaseAssetSummary, ShowcaseFeedItem } from './types';

export type CreatorProfileTab = 'posts' | 'unlocks' | 'tools';

export type CreatorProfileVideoPreviewLayout = {
  height: number;
  y: number;
};

export const CREATOR_PROFILE_TABS: Array<{ id: CreatorProfileTab; label: string }> = [
  { id: 'posts', label: 'Posts' },
  { id: 'unlocks', label: 'Unlocks' },
  { id: 'tools', label: 'Tools' },
];

export function normalizeCreatorProfileTab(value: string | string[] | undefined): CreatorProfileTab {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const tab = rawValue?.toLowerCase();
  return tab === 'unlocks' || tab === 'tools' ? tab : 'posts';
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

export function creatorProfileUnlockSummary(asset: ShowcaseAssetSummary | null) {
  if (!asset) return null;

  const labels = (asset.resourceKinds ?? []).reduce<string[]>((current, kind) => {
    const label = creatorUnlockResourceLabel(kind);
    if (label) current.push(label);
    return current;
  }, []);

  if (asset.allowRemix && !labels.includes('Remix')) {
    labels.push('Remix');
  }

  if (labels.length) return labels.join(' + ');

  const previewText = asset.previewText.trim();
  return previewText || null;
}

export function selectActiveCreatorProfileVideoId(
  items: ShowcaseFeedItem[],
  layouts: Record<string, CreatorProfileVideoPreviewLayout>,
  gridTop: number | null,
  scrollOffsetY: number,
  viewportHeight: number
) {
  if (gridTop === null || viewportHeight <= 0) return null;

  const viewportTop = Math.max(0, scrollOffsetY);
  const viewportBottom = viewportTop + viewportHeight;
  let selected: { id: string; top: number; visibleRatio: number } | null = null;

  for (const item of items) {
    if (!hasShowcaseVideoWithoutPreview(item)) continue;
    const layout = layouts[item.id];
    if (!layout || layout.height <= 0) continue;

    const top = gridTop + layout.y;
    const bottom = top + layout.height;
    const visibleHeight = Math.max(0, Math.min(bottom, viewportBottom) - Math.max(top, viewportTop));
    const visibleRatio = visibleHeight / layout.height;

    if (!visibleRatio) continue;
    if (!selected || visibleRatio > selected.visibleRatio || (visibleRatio === selected.visibleRatio && top < selected.top)) {
      selected = { id: item.id, top, visibleRatio };
    }
  }

  return selected?.id ?? null;
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

function creatorUnlockResourceLabel(kind: string) {
  if (kind === 'prompt') return 'Prompt';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'files') return 'Files';
  if (kind === 'notes') return 'Notes';
  if (kind === 'remix') return 'Remix';
  return null;
}
