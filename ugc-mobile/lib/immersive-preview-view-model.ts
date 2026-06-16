import type { CreatorToolId, GenerationListItem, OwnerPostListItem, PostResourceKind, ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/types';

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

export interface ImmersivePreviewResource {
  resourceId: string;
  postId: string;
  title: string;
  accessMode: 'free' | 'paid';
  priceUsdCents: number;
  previewText: string;
  allowRemix: boolean;
  resourceKinds: string[];
  priceQuote?: { formatted?: string; amountSubunits?: number; currency?: string };
}

export interface ImmersivePostUnlockDetails {
  resourceId: string;
  postId: string;
  title: string;
  accessMode: 'free' | 'paid';
  priceLabel: string;
  previewText: string | null;
  resourceKinds: PostResourceKind[];
  allowRemix: boolean;
}

export interface ImmersivePostDetails {
  title: string;
  prompt: string;
  body: string;
  categoryLabel: string;
  sourceLabel: string;
  creatorLabel: string;
  creatorAvatar: string | null;
  saveCount: number;
  remixCount: number;
  unlock: ImmersivePostUnlockDetails | null;
  generationInfo?: {
    model: string;
    createdAt: string;
    duration: number | null;
    cost: number | null;
    inputMedia: Array<{ url?: string | null; kind?: string | null }> | null;
  } | null;
}

export interface ImmersivePreviewItem {
  id: string;
  source: PreviewViewerSource;
  sourceType: ImmersivePreviewSourceType;
  title: string;
  displayText: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  mediaItems: ShowcaseMediaItem[];
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
  resource?: ImmersivePreviewResource;
  details?: ImmersivePostDetails;
  linkedPostId?: string | null;
  linkedPostTitle?: string | null;
  linkedPostVisibility?: string | null;
  linkedPostArchivedAt?: string | null;
  linkedPostBundle?: OwnerPostListItem['bundle'] | null;
  linkedPostPath?: string | null;
  linkedPostOwnerPath?: string | null;
  archivedAt?: string | null;
  visibility?: string | null;
  availableActions: string[];
  disabledActions: Record<string, string>;
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

export function profileMediaFeedHref({
  source,
  initialId,
}: {
  source: PreviewViewerSource;
  initialId: string;
}) {
  return {
    pathname: '/profile-media-feed',
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
  owner: { creatorLabel: string; creatorAvatar?: string | null },
  ownerPosts: OwnerPostListItem[] = []
) {
  return items.map((item) => generationToImmersiveItem(source, item, owner, ownerPosts));
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

export function selectActiveImmersiveVideoId(
  items: ImmersivePreviewItem[],
  activeIndex: number,
  detailsOpenItemId?: string | null
) {
  const item = items[activeIndex];
  if (item?.id && item.id === detailsOpenItemId) {
    return null;
  }
  return item?.mediaKind === 'video' && item.mediaUrl ? item.id : null;
}

export function isImmersiveVideoItem(item: ImmersivePreviewItem) {
  return item.mediaKind === 'video' && Boolean(item.mediaUrl);
}

export function hasImmersiveDetailsPage(item: ImmersivePreviewItem) {
  return Boolean(item.details) && item.sourceType !== 'generation';
}

export function getImmersiveHorizontalPageIndex(detailsOpen: boolean) {
  return detailsOpen ? 1 : 0;
}

export function isImmersiveDetailsHorizontalPage(pageIndex: number) {
  return pageIndex === 1;
}

function getMediaItemsList(
  id: string,
  mediaUrl: string | null,
  mediaKind: 'image' | 'video' | null,
  mediaItems?: ShowcaseMediaItem[]
): ShowcaseMediaItem[] {
  if (mediaItems?.length) {
    return mediaItems;
  }
  if (!mediaUrl || !mediaKind) {
    return [];
  }
  return [{
    id: `${id}:cover`,
    url: mediaUrl,
    mediaKind: mediaKind === 'video' ? 'video' : 'image',
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  }];
}

function getGenerationMediaItemsList(
  id: string,
  outputUrls: string[] | undefined,
  outputUrl: string | null,
  mediaKind: 'image' | 'video' | null,
  previewUrl?: string | null
): ShowcaseMediaItem[] {
  if (outputUrls?.length && mediaKind) {
    return outputUrls.map((url, index) => ({
      id: `${id}:${index}`,
      url,
      previewUrl: index === 0 ? previewUrl ?? (mediaKind === 'image' ? url : null) : mediaKind === 'image' ? url : null,
      mediaKind: mediaKind === 'video' ? 'video' : 'image',
      contentType: null,
      originalName: null,
      width: null,
      height: null,
      durationSeconds: null,
      sortOrder: index,
    }));
  }
  if (!outputUrl || !mediaKind) {
    return [];
  }
  return [{
    id: `${id}:output`,
    url: outputUrl,
    previewUrl: previewUrl ?? (mediaKind === 'image' ? outputUrl : null),
    mediaKind: mediaKind === 'video' ? 'video' : 'image',
    contentType: null,
    originalName: null,
    width: null,
    height: null,
    durationSeconds: null,
    sortOrder: 0,
  }];
}

function showcaseToImmersiveItem(source: PreviewViewerSource, item: ShowcaseFeedItem): ImmersivePreviewItem {
  const displayText = getShowcasePostDisplayText(item);
  const title = item.title.trim() || item.prompt.trim() || displayText;
  const textOnly = isTextOnlyShowcasePost(item);
  const creatorLabel = creatorHandle(item.creator.username, item.creator.name);

  return {
    id: item.id,
    source,
    sourceType: 'showcase',
    title,
    displayText,
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    mediaItems: getMediaItemsList(item.id, item.mediaUrl, item.mediaKind, item.mediaItems),
    previewKind: textOnly ? 'text' : undefined,
    creatorLabel,
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
    resource: showcaseResource(item),
    details: {
      title,
      prompt: item.prompt.trim(),
      body: item.body.trim(),
      categoryLabel: categoryLabel(item.category, item.postFormat),
      sourceLabel: 'Showcase',
      creatorLabel,
      creatorAvatar: item.creator.avatar,
      saveCount: item.saveCount,
      remixCount: item.remixCount,
      unlock: item.asset ? {
        resourceId: item.asset.id,
        postId: item.asset.postId || item.id,
        title: item.asset.title.trim() || title,
        accessMode: item.asset.accessMode,
        priceLabel: item.asset.accessMode === 'free'
          ? 'Free'
          : item.asset.priceQuote?.formatted ?? formatUsdCents(item.asset.priceUsdCents),
        previewText: item.asset.previewText?.trim() || null,
        resourceKinds: normalizeResourceKinds(item.asset.resourceKinds),
        allowRemix: Boolean(item.asset.allowRemix),
      } : null,
    },
    linkedPostId: null,
    linkedPostTitle: null,
    linkedPostVisibility: null,
    archivedAt: null,
    visibility: 'public',
    availableActions: ['unsave', 'share', 'recreate', 'view-details', 'open-original'],
    disabledActions: {},
  };
}

function generationToImmersiveItem(
  source: PreviewViewerSource,
  item: GenerationListItem,
  owner: { creatorLabel: string; creatorAvatar?: string | null },
  ownerPosts: OwnerPostListItem[]
): ImmersivePreviewItem {
  const kind = generationKind(item);
  const displayText = item.prompt?.trim() || item.description?.trim() || item.title?.trim() || 'Saved Magicbooklet generation.';
  const title = item.title?.trim() || displayText;
  const mediaKind = kind === 'text' ? null : kind === 'image' ? 'image' : 'video';
  const previewUrl = item.previewUrl ?? item.preview_url ?? null;
  const linkedPost = findLinkedOwnerPost(item, ownerPosts);
  const linkedPostId = linkedPost?.id ?? item.linked_post_id ?? null;
  const linkedPostVisibility = linkedPost?.visibility ?? item.linked_post_visibility ?? null;
  const linkedPostArchivedAt = linkedPost?.archivedAt ?? item.linked_post_archived_at ?? null;
  const linkedPostPath = linkedPost?.publicPath
    ?? (linkedPostId && linkedPostVisibility !== 'private' && !linkedPostArchivedAt ? `/showcase/${linkedPostId}` : null);
  const linkedPostOwnerPath = linkedPost?.ownerPath ?? (linkedPostId ? `/post/${linkedPostId}/edit` : null);

  return {
    id: item.id,
    source,
    sourceType: 'generation',
    title,
    displayText,
    mediaUrl: item.output_urls?.[0] ?? item.output_url ?? null,
    mediaKind,
    mediaItems: getGenerationMediaItemsList(item.id, item.output_urls, item.output_url, mediaKind, previewUrl),
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
    showcasePostId: linkedPostId,
    generationId: item.id,
    ownerPostId: null,
    details: {
      title,
      prompt: item.prompt?.trim() ?? '',
      body: item.description?.trim() ?? '',
      categoryLabel: kind === 'motion' ? 'Motion' : kind === 'video' ? 'Video' : kind === 'text' ? 'Text' : 'Image',
      sourceLabel: 'Creations',
      creatorLabel: owner.creatorLabel,
      creatorAvatar: owner.creatorAvatar ?? null,
      saveCount: 0,
      remixCount: 0,
      unlock: null,
      generationInfo: {
        model: item.model,
        createdAt: item.created_at,
        duration: item.duration ?? null,
        cost: item.cost ?? null,
        inputMedia: item.input_media ?? null,
      },
    },
    linkedPostId,
    linkedPostTitle: linkedPost?.title ?? item.linked_post_title ?? null,
    linkedPostVisibility,
    linkedPostArchivedAt,
    linkedPostBundle: linkedPost?.bundle ?? null,
    linkedPostPath,
    linkedPostOwnerPath,
    archivedAt: item.archived_at ?? null,
    visibility: null,
    availableActions: getGenerationAvailableActions(item, linkedPostId, linkedPostVisibility),
    disabledActions: item.archived_at
      ? {
          publish: 'This creation is archived',
          recreate: 'This creation is archived',
          archive: 'This creation is archived',
          share: 'This creation is archived',
        }
      : {},
  };
}

function findLinkedOwnerPost(item: GenerationListItem, ownerPosts: OwnerPostListItem[]) {
  return ownerPosts.find((post) => post.generationId === item.id)
    ?? (item.linked_post_id ? ownerPosts.find((post) => post.id === item.linked_post_id) : null)
    ?? null;
}

function getGenerationAvailableActions(
  item: GenerationListItem,
  linkedPostId: string | null,
  linkedPostVisibility: string | null
) {
  if (item.archived_at) {
    return ['restore', 'view-details'];
  }

  if (!linkedPostId) {
    return ['publish', 'recreate', 'archive', 'share', 'view-details'];
  }

  const linkedActions = ['edit-linked-resources'];
  if (linkedPostVisibility === 'public') {
    linkedActions.push('make-private');
  } else if (linkedPostVisibility === 'private') {
    linkedActions.push('make-public');
  }

  return [...linkedActions, 'view-linked', 'recreate', 'archive', 'share', 'view-details'];
}

function ownerPostToImmersiveItem(
  source: PreviewViewerSource,
  item: OwnerPostListItem,
  owner: { creatorLabel: string; creatorAvatar?: string | null }
): ImmersivePreviewItem {
  const textOnly = (item.category === 'text' || item.postFormat === 'text') && !item.mediaUrl;
  const displayText = item.body?.trim() || item.prompt?.trim() || item.title.trim() || 'Community post';
  const prompt = item.prompt?.trim() || item.body?.trim() || item.description?.trim() || item.title.trim();
  const title = item.title.trim() || displayText;

  return {
    id: item.id,
    source,
    sourceType: 'owner-post',
    title,
    displayText,
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    mediaItems: getMediaItemsList(item.id, item.mediaUrl, item.mediaKind, item.mediaItems),
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
    resource: ownerPostResource(item, displayText),
    details: {
      title,
      prompt: item.prompt?.trim() ?? '',
      body: item.body?.trim() || item.description?.trim() || '',
      categoryLabel: categoryLabel(item.category, item.postFormat),
      sourceLabel: item.sourceLabel?.trim() || 'Post',
      creatorLabel: owner.creatorLabel,
      creatorAvatar: owner.creatorAvatar ?? null,
      saveCount: 0,
      remixCount: 0,
      unlock: item.bundle ? {
        resourceId: item.bundle.id,
        postId: item.id,
        title,
        accessMode: item.bundle.accessMode,
        priceLabel: item.bundle.accessMode === 'free' ? 'Free' : formatUsdCents(item.bundle.priceUsdCents),
        previewText: null,
        resourceKinds: normalizeResourceKinds(item.bundle.resourceKinds),
        allowRemix: item.bundle.resourceKinds.includes('remix'),
      } : null,
    },
    linkedPostId: null,
    linkedPostTitle: null,
    linkedPostVisibility: null,
    archivedAt: item.archivedAt ?? null,
    visibility: item.visibility,
    availableActions: item.archivedAt
      ? ['restore', 'share', 'download', 'view-details']
      : ['edit-post', 'change-visibility', 'archive', 'share', 'download', 'view-details'],
    disabledActions: item.archivedAt
      ? {
          'edit-post': 'This post is archived',
          'change-visibility': 'This post is archived',
        }
      : {},
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

function categoryLabel(
  category: ShowcaseFeedItem['category'] | OwnerPostListItem['category'] | undefined,
  postFormat?: ShowcaseFeedItem['postFormat'] | OwnerPostListItem['postFormat']
) {
  if (category === 'text' || postFormat === 'text') return 'Prompt';
  if (category === 'ugc-ad') return 'UGC Ad';
  if (category === 'motion') return 'Motion';
  if (category === 'video') return 'Video';
  return 'Image';
}

function normalizeResourceKinds(kinds: Array<string | PostResourceKind> | null | undefined): PostResourceKind[] {
  const allowed = new Set<PostResourceKind>(['prompt', 'workflow', 'files', 'notes', 'remix']);
  return (kinds ?? []).filter((kind): kind is PostResourceKind => allowed.has(kind as PostResourceKind));
}

function formatUsdCents(amount: number) {
  return `$${(amount / 100).toFixed(2)}`;
}

function showcaseResource(item: ShowcaseFeedItem): ImmersivePreviewResource | undefined {
  if (!item.asset) return undefined;

  return {
    resourceId: item.asset.id,
    postId: item.asset.postId || item.id,
    title: item.asset.title || item.title || item.prompt || 'Creator unlock',
    accessMode: item.asset.accessMode,
    priceUsdCents: item.asset.priceUsdCents,
    previewText: item.asset.previewText || item.body || item.prompt || item.title,
    allowRemix: item.asset.allowRemix,
    resourceKinds: item.asset.resourceKinds ?? [],
    priceQuote: item.asset.priceQuote,
  };
}

function ownerPostResource(item: OwnerPostListItem, displayText: string): ImmersivePreviewResource | undefined {
  if (!item.bundle) return undefined;

  return {
    resourceId: item.bundle.id,
    postId: item.id,
    title: item.title || 'Creator unlock',
    accessMode: item.bundle.accessMode,
    priceUsdCents: item.bundle.priceUsdCents,
    previewText: item.body || item.prompt || item.description || displayText,
    allowRemix: false,
    resourceKinds: item.bundle.resourceKinds,
    priceQuote: undefined,
  };
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
