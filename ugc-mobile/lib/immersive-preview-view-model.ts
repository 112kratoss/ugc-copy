import type { CreatorToolId, GenerationListItem, OwnerPostListItem, ShowcaseFeedItem } from '@/lib/types';

import { formatCompactCount } from './home-view-model';
import { getShowcasePostDisplayText, isTextOnlyShowcasePost } from './showcase-display';

export type PreviewViewerSource =
  | 'showcase-feed'
  | 'home-community'
  | 'profile-saved'
  | 'profile-posts'
  | 'profile-creations'
  | 'studio-creations'
  | 'home-creations';

export type ImmersivePreviewSourceType = 'showcase' | 'generation' | 'owner-post';

export interface ImmersivePreviewItem {
  id: string;
  source: PreviewViewerSource;
  sourceType: ImmersivePreviewSourceType;
  title: string;
  displayText: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  previewKind?: 'text';
  creatorLabel: string;
  creatorAvatar: string | null;
  badge: string;
  saveLabel: string;
  saveCount: number;
  isSaved: boolean;
  canSave: boolean;
  canShare: boolean;
  sharePath: string | null;
  recreateTool: CreatorToolId;
  recreatePrompt: string;
  showcasePostId: string | null;
  generationId: string | null;
  ownerPostId: string | null;
}

export function immersiveViewerHref({
  source,
  initialId,
}: {
  source: PreviewViewerSource;
  initialId: string;
}) {
  return {
    pathname: '/viewer',
    params: {
      source,
      initialId,
    },
  };
}

export function buildImmersiveShowcaseItems(source: PreviewViewerSource, items: ShowcaseFeedItem[]) {
  return items.map((item) => showcaseToImmersiveItem(source, item));
}

export function buildImmersiveGenerationItems(
  source: PreviewViewerSource,
  items: GenerationListItem[],
  owner: { creatorLabel: string; creatorAvatar?: string | null }
) {
  return items.map((item) => generationToImmersiveItem(source, item, owner));
}

export function buildImmersiveOwnerPostItems(
  source: PreviewViewerSource,
  items: OwnerPostListItem[],
  owner: { creatorLabel: string; creatorAvatar?: string | null }
) {
  return items.map((item) => ownerPostToImmersiveItem(source, item, owner));
}

export function getImmersiveInitialIndex(items: ImmersivePreviewItem[], initialId: string | null | undefined) {
  if (!initialId) return 0;
  const index = items.findIndex((item) => item.id === initialId);
  return index >= 0 ? index : 0;
}

export function selectActiveImmersiveVideoId(items: ImmersivePreviewItem[], activeIndex: number) {
  const item = items[activeIndex];
  return item?.mediaKind === 'video' && item.mediaUrl ? item.id : null;
}

export function isImmersiveVideoItem(item: ImmersivePreviewItem) {
  return item.mediaKind === 'video' && Boolean(item.mediaUrl);
}

function showcaseToImmersiveItem(source: PreviewViewerSource, item: ShowcaseFeedItem): ImmersivePreviewItem {
  const displayText = getShowcasePostDisplayText(item);
  const title = item.title.trim() || item.prompt.trim() || displayText;
  const textOnly = isTextOnlyShowcasePost(item);

  return {
    id: item.id,
    source,
    sourceType: 'showcase',
    title,
    displayText,
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    previewKind: textOnly ? 'text' : undefined,
    creatorLabel: creatorHandle(item.creator.username, item.creator.name),
    creatorAvatar: item.creator.avatar,
    badge: showcaseBadge(item),
    saveLabel: formatCompactCount(item.saveCount),
    saveCount: item.saveCount,
    isSaved: Boolean(item.isSaved),
    canSave: true,
    canShare: true,
    sharePath: `/showcase/${item.id}`,
    recreateTool: toolForShowcaseItem(item),
    recreatePrompt: item.prompt.trim() || item.body.trim() || item.title.trim(),
    showcasePostId: item.id,
    generationId: item.generationId,
    ownerPostId: null,
  };
}

function generationToImmersiveItem(
  source: PreviewViewerSource,
  item: GenerationListItem,
  owner: { creatorLabel: string; creatorAvatar?: string | null }
): ImmersivePreviewItem {
  const kind = generationKind(item);
  const displayText = item.prompt?.trim() || item.description?.trim() || item.title?.trim() || 'Saved Magicbooklet generation.';
  const title = item.title?.trim() || displayText;

  return {
    id: item.id,
    source,
    sourceType: 'generation',
    title,
    displayText,
    mediaUrl: item.output_urls?.[0] ?? item.output_url ?? null,
    mediaKind: kind === 'text' ? null : kind === 'image' ? 'image' : 'video',
    previewKind: kind === 'text' ? 'text' : undefined,
    creatorLabel: owner.creatorLabel,
    creatorAvatar: owner.creatorAvatar ?? null,
    badge: generationBadge(kind),
    saveLabel: '0',
    saveCount: 0,
    isSaved: false,
    canSave: false,
    canShare: true,
    sharePath: null,
    recreateTool: kind === 'motion' ? 'motion' : kind === 'video' ? 'video' : 'image',
    recreatePrompt: item.prompt?.trim() || item.description?.trim() || item.title?.trim() || '',
    showcasePostId: item.linked_post_id ?? null,
    generationId: item.id,
    ownerPostId: null,
  };
}

function ownerPostToImmersiveItem(
  source: PreviewViewerSource,
  item: OwnerPostListItem,
  owner: { creatorLabel: string; creatorAvatar?: string | null }
): ImmersivePreviewItem {
  const textOnly = (item.category === 'text' || item.postFormat === 'text') && !item.mediaUrl;
  const displayText = item.body?.trim() || item.prompt?.trim() || item.title.trim() || 'Community post';
  const prompt = item.prompt?.trim() || item.body?.trim() || item.description?.trim() || item.title.trim();

  return {
    id: item.id,
    source,
    sourceType: 'owner-post',
    title: item.title.trim() || displayText,
    displayText,
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    previewKind: textOnly ? 'text' : undefined,
    creatorLabel: owner.creatorLabel,
    creatorAvatar: owner.creatorAvatar ?? null,
    badge: ownerPostBadge(item),
    saveLabel: '0',
    saveCount: 0,
    isSaved: false,
    canSave: false,
    canShare: true,
    sharePath: item.publicPath ?? null,
    recreateTool: toolForOwnerPost(item),
    recreatePrompt: prompt,
    showcasePostId: item.id,
    generationId: null,
    ownerPostId: item.id,
  };
}

function creatorHandle(username: string | null, name: string) {
  if (username?.trim()) return `@${username.replace(/^@+/, '')}`;
  return name.trim() || '@creator';
}

function showcaseBadge(item: ShowcaseFeedItem) {
  if (item.asset?.accessMode === 'free') return 'Free unlock';
  if (item.asset?.priceQuote?.formatted) return item.asset.priceQuote.formatted;
  if (item.canRemix || item.asset?.allowRemix) return 'Remix';
  if (item.category === 'text' || item.postFormat === 'text') return 'Prompt';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  if (item.category === 'motion') return 'Motion';
  return 'Image';
}

function ownerPostBadge(item: OwnerPostListItem) {
  if (item.bundle?.accessMode === 'free') return 'Free unlock';
  if (item.bundle?.accessMode === 'paid') return 'Paid unlock';
  if (item.category === 'text' || item.postFormat === 'text') return 'Prompt';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  if (item.category === 'motion') return 'Motion';
  return 'Post';
}

function generationKind(item: GenerationListItem) {
  if (item.category === 'video') return 'video';
  if (item.category === 'motion') return 'motion';
  if (item.category === 'text') return 'text';
  return 'image';
}

function generationBadge(kind: ReturnType<typeof generationKind>) {
  if (kind === 'motion') return 'Motion';
  if (kind === 'video') return 'Video';
  if (kind === 'text') return 'Text';
  return 'Image';
}

function toolForShowcaseItem(item: ShowcaseFeedItem): CreatorToolId {
  if (item.category === 'video' || item.category === 'ugc-ad') return 'video';
  if (item.category === 'motion') return 'motion';
  return 'image';
}

function toolForOwnerPost(item: OwnerPostListItem): CreatorToolId {
  if (item.category === 'video' || item.mediaKind === 'video') return 'video';
  if (item.category === 'motion') return 'motion';
  return 'image';
}
