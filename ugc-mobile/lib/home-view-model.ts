import type { CreatorToolId, GenerationListItem, OwnerPostListItem, ShowcaseFeedItem } from '@/lib/types';
import type { ToolAccent } from '@/lib/theme';
import type { PreviewViewerSource } from './immersive-preview-view-model';
import { getShowcasePostDisplayText, isTextOnlyShowcasePost } from './showcase-display';

export type HomeToolShortcutId = CreatorToolId | 'workflow';

export interface HomeToolShortcut {
  id: HomeToolShortcutId;
  title: string;
  body: string;
  accent: ToolAccent;
  href: string | null;
  previewVariant: 'kingdom' | 'city' | 'runner' | null;
  badge?: string;
}

export interface HomeGenerationCard {
  id: string;
  title: string;
  kind: 'image' | 'video' | 'motion' | 'text';
  label: string;
  timeLabel: string;
  mediaUrl: string | null;
  previewText: string;
  artVariant: 'kingdom' | 'city' | 'runner' | 'tree';
  viewerSource: PreviewViewerSource;
  sourceId: string;
}

export interface HomeCommunityCard {
  id: string;
  creatorName: string;
  creatorHandle: string;
  title: string;
  body: string;
  mediaUrl: string | null;
  previewUrl?: string | null;
  mediaKind: 'image' | 'video' | null;
  previewKind: 'media' | 'text';
  timeLabel: string;
  saveLabel: string;
  accessLabel: string;
  artVariant: 'tree' | 'portal' | 'city';
  viewerSource: PreviewViewerSource;
  sourceId: string;
}

export const HOME_TOOL_SHORTCUTS: HomeToolShortcut[] = [
  {
    id: 'image',
    title: 'Image',
    body: 'Polished stills, hooks, and product frames.',
    accent: 'image',
    href: '/create/image',
    previewVariant: 'kingdom',
  },
  {
    id: 'video',
    title: 'Video',
    body: 'Prompt-to-clip scenes for launch content.',
    accent: 'video',
    href: '/create/video',
    previewVariant: 'city',
  },
  {
    id: 'motion',
    title: 'Motion',
    body: 'Animate a face, product, or creator visual.',
    accent: 'motion',
    href: '/create/motion',
    previewVariant: 'runner',
  },
  {
    id: 'workflow',
    title: 'Workflow',
    body: 'Reusable systems are coming to mobile.',
    accent: 'workflow',
    href: null,
    previewVariant: null,
    badge: 'Soon',
  },
];

export const FALLBACK_GENERATIONS: HomeGenerationCard[] = [
  {
    id: 'preview-floating-kingdom',
    title: 'Floating Kingdom',
    kind: 'image',
    label: 'Image',
    timeLabel: '2m ago',
    mediaUrl: null,
    previewText: 'A luminous floating kingdom above soft morning clouds.',
    artVariant: 'kingdom',
    viewerSource: 'home-creations',
    sourceId: 'preview-floating-kingdom',
  },
  {
    id: 'preview-cyber-drive',
    title: 'Cyber City Drive',
    kind: 'video',
    label: 'Video',
    timeLabel: '10m ago',
    mediaUrl: null,
    previewText: 'A neon cyber city drive with cinematic motion.',
    artVariant: 'city',
    viewerSource: 'home-creations',
    sourceId: 'preview-cyber-drive',
  },
  {
    id: 'preview-astronaut-run',
    title: 'Astronaut Run',
    kind: 'motion',
    label: 'Motion',
    timeLabel: '1h ago',
    mediaUrl: null,
    previewText: 'An astronaut sprinting through a moonlit studio scene.',
    artVariant: 'runner',
    viewerSource: 'home-creations',
    sourceId: 'preview-astronaut-run',
  },
];

export const FALLBACK_COMMUNITY: HomeCommunityCard[] = [
  {
    id: 'preview-luna-dreams',
    creatorName: 'LunaDreams',
    creatorHandle: '@lunadreams',
    title: 'Celestial Grove Prompt',
    body: 'A glowing island scene with soft pink clouds, cinematic lighting, and a premium fantasy editorial finish.',
    mediaUrl: null,
    mediaKind: 'image',
    previewKind: 'media',
    timeLabel: '2h ago',
    saveLabel: '1.2K',
    accessLabel: 'Paywalled',
    artVariant: 'tree',
    viewerSource: 'home-community',
    sourceId: 'preview-luna-dreams',
  },
];

export function formatCompactCount(value: number | null | undefined) {
  const safeValue = Math.max(0, value ?? 0);
  if (safeValue >= 1_000_000) return `${trimOneDecimal(safeValue / 1_000_000)}M`;
  if (safeValue >= 1_000) return `${trimOneDecimal(safeValue / 1_000)}K`;
  return String(safeValue);
}

export function formatUsdCents(value: number | null | undefined) {
  const safeValue = Math.max(0, value ?? 0);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: safeValue % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(safeValue / 100);
}

export function getOwnerPostSalesSummary(posts: OwnerPostListItem[] | null | undefined) {
  return (posts ?? []).reduce(
    (summary, item) => ({
      salesCount: summary.salesCount + (item.bundle?.salesCount ?? 0),
      earningsUsdCents: summary.earningsUsdCents + (item.bundle?.earningsUsdCents ?? 0),
    }),
    { salesCount: 0, earningsUsdCents: 0 }
  );
}

export function formatRelativeTime(value: string | null | undefined, now = new Date()) {
  if (!value) return 'Just now';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'Just now';

  const diffSeconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (diffSeconds < 60) return 'Just now';

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;

  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

export function generationToHomeCard(item: GenerationListItem): HomeGenerationCard {
  const kind = generationKind(item);
  return {
    id: item.id,
    title: item.title || item.prompt || 'Untitled creation',
    kind,
    label: generationLabel(kind),
    timeLabel: formatRelativeTime(item.completed_at ?? item.created_at),
    mediaUrl: item.output_urls?.[0] ?? item.output_url ?? null,
    previewText: item.prompt || item.description || item.title || 'A saved Magic Booklet generation.',
    artVariant: kind === 'text' ? 'tree' : kind === 'motion' ? 'runner' : kind === 'video' ? 'city' : 'kingdom',
    viewerSource: 'home-creations',
    sourceId: item.id,
  };
}

export function generationsToHomeCards(items: GenerationListItem[]) {
  return items.slice(0, 6).map(generationToHomeCard);
}

export function showcaseToCommunityCard(item: ShowcaseFeedItem): HomeCommunityCard {
  const hasUsableMedia = Boolean(item.mediaUrl && item.mediaKind);
  const previewKind = isTextOnlyShowcasePost(item) || !hasUsableMedia ? 'text' : 'media';

  return {
    id: item.id,
    creatorName: item.creator.name,
    creatorHandle: item.creator.username ? `@${item.creator.username}` : '@creator',
    title: item.title || item.prompt || 'Community creation',
    body: getShowcasePostDisplayText(item),
    mediaUrl: item.mediaUrl,
    previewUrl: item.mediaItems?.[0]?.previewUrl ?? null,
    mediaKind: item.mediaKind,
    previewKind,
    timeLabel: formatRelativeTime(item.createdAt),
    saveLabel: formatCompactCount(item.saveCount),
    accessLabel: item.asset ? (item.asset.accessMode === 'free' ? 'Free unlock' : 'Paywalled') : 'Open',
    artVariant: item.category === 'video' ? 'city' : item.category === 'motion' ? 'portal' : 'tree',
    viewerSource: 'home-community',
    sourceId: item.id,
  };
}

function generationKind(item: GenerationListItem): HomeGenerationCard['kind'] {
  if (item.category === 'video') return 'video';
  if (item.category === 'motion') return 'motion';
  if (item.category === 'text') return 'text';
  return 'image';
}

function generationLabel(kind: HomeGenerationCard['kind']) {
  if (kind === 'motion') return 'Motion';
  if (kind === 'video') return 'Video';
  if (kind === 'text') return 'Text';
  return 'Image';
}

function trimOneDecimal(value: number) {
  return value.toFixed(1).replace(/\.0$/, '');
}
