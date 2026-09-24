import type { CreatorToolId, GenerationListItem, OwnerPostListItem, PostResourceKind, ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/types';

import { withAppleZoom, type AppleZoomOpen } from './apple-zoom';
import { getCreationAvailability, type CreationAvailability } from './creation-library';
import { getGenerationKind, getGenerationLabel, getGenerationRenderableMediaKind } from './generation-media';
import { formatCompactCount } from './home-view-model';
import { formatUnlockCreditPrice } from './pricing';
import { getShowcasePostDisplayText, isTextOnlyShowcasePost } from './showcase-display';

export type PreviewViewerSource =
  | 'showcase-feed'
  | 'creator-profile'
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
  /** The tool (and model) the post was made with, when the source names one. */
  toolLabel?: string | null;
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
  creatorId?: string | null;
  creatorUsername?: string | null;
  /** Source timestamp, used by the profile card feed's relative time label. */
  createdAt?: string | null;
  badge: string;
  saveLabel: string;
  saveCount: number;
  commentLabel: string;
  commentCount: number;
  canComment: boolean;
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
  /**
   * Whether the linked post's own record was loaded, so `linkedPostBundle` is
   * known rather than merely absent. Linked-post details are enrichment that can
   * be missing; an action that depends on the bundle reads the post first.
   */
  linkedPostDetailsLoaded?: boolean;
  /** The post's own recipe, for an owned post, so lifecycle policy can see its state. */
  ownerPostBundle?: OwnerPostListItem['bundle'] | null;
  linkedPostPath?: string | null;
  linkedPostOwnerPath?: string | null;
  archivedAt?: string | null;
  /**
   * The generation's own run state. Carried because a slide with no media has
   * to say *why* it has none, and a failed run and one still rendering are
   * indistinguishable from an empty `mediaItems` alone.
   */
  runStatus?: string | null;
  /**
   * Whether a creation has a file to show and, if not, why. A card or slide with
   * nothing to play draws this state instead of disappearing (audit C1).
   */
  availability?: CreationAvailability;
  visibility?: string | null;
  isManualOwnerPost?: boolean;
  availableActions: string[];
  disabledActions: Record<string, string>;
  recommendation?: ShowcaseFeedItem['recommendation'];
}

export function immersiveViewerHref({
  algorithmVersion,
  creatorUsername,
  feedSessionId,
  mediaOnly,
  source,
  initialId,
  zoom = null,
}: {
  algorithmVersion?: string | null;
  creatorUsername?: string | null;
  feedSessionId?: string | null;
  mediaOnly?: boolean;
  source: PreviewViewerSource;
  initialId: string;
  /** The zoom the tapped tile hands the push on iOS 18 (lib/apple-zoom.ts). */
  zoom?: AppleZoomOpen | null;
}) {
  return withAppleZoom({
    pathname: '/viewer',
    params: {
      source,
      initialId,
      ...(mediaOnly ? { mediaOnly: '1' } : {}),
      ...(feedSessionId ? { feedSessionId } : {}),
      ...(algorithmVersion ? { algorithmVersion } : {}),
      ...(creatorUsername ? { creatorUsername } : {}),
    },
  }, zoom);
}

export function textPostViewerHref({
  comments = false,
  postId,
  source,
}: {
  comments?: boolean;
  postId: string;
  source?: 'profile-posts' | 'profile-saved';
}) {
  const pathname = `/post/${encodeURIComponent(postId)}`;
  const params = [
    ...(source ? [['source', source]] : []),
    ...(comments ? [['comments', postId]] : []),
  ];
  return params.length
    ? `${pathname}?${params
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&')}`
    : pathname;
}

export function immersivePreviewOpenHref(
  item: ImmersivePreviewItem,
  options: { comments?: boolean; zoom?: AppleZoomOpen | null } = {}
) {
  if (item.previewKind === 'text' && item.sourceType !== 'generation') {
    return textPostViewerHref({
      comments: options.comments,
      postId: item.id,
      source: item.sourceType === 'owner-post'
        ? 'profile-posts'
        : item.source === 'profile-saved'
          ? 'profile-saved'
          : undefined,
    });
  }

  return immersiveViewerHref({ source: item.source, initialId: item.id, zoom: options.zoom });
}

/**
 * The immersive viewer is a media reel, so a text-only post has nothing to fill
 * it and opens its own screen instead of being dropped into a vertical feed of
 * other people's media. Every `ShowcaseFeedItem` surface routes taps through
 * here so the predicate that renders a tile as text is the same one that decides
 * where the tile opens.
 */
export function showcaseFeedItemOpenHref({
  algorithmVersion,
  comments,
  creatorUsername,
  feedSessionId,
  mediaOnly,
  item,
  source,
  zoom,
}: {
  algorithmVersion?: string | null;
  comments?: boolean;
  creatorUsername?: string | null;
  feedSessionId?: string | null;
  mediaOnly?: boolean;
  item: ShowcaseFeedItem;
  source: PreviewViewerSource;
  /** The zoom the tapped tile hands the push on iOS 18 (lib/apple-zoom.ts). */
  zoom?: AppleZoomOpen | null;
}) {
  if (isTextOnlyShowcasePost(item)) {
    return textPostViewerHref({ comments, postId: item.id });
  }

  return immersiveViewerHref({
    algorithmVersion,
    creatorUsername,
    feedSessionId,
    source,
    initialId: item.id,
    mediaOnly,
    zoom,
  });
}

export function immersiveViewerReturnPath({
  algorithmVersion,
  creatorUsername,
  feedSessionId,
  mediaOnly,
  source,
  initialId,
}: {
  algorithmVersion?: string | null;
  creatorUsername?: string | null;
  feedSessionId?: string | null;
  mediaOnly?: boolean;
  source: PreviewViewerSource;
  initialId: string;
}) {
  const params = [
    ['source', source],
    ['initialId', initialId],
    ...(mediaOnly ? [['mediaOnly', '1']] : []),
    ...(feedSessionId ? [['feedSessionId', feedSessionId]] : []),
    ...(algorithmVersion ? [['algorithmVersion', algorithmVersion]] : []),
    ...(creatorUsername ? [['creatorUsername', creatorUsername]] : []),
  ];
  return `/viewer?${params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

/**
 * Owned media (Creations, Posts) opens the card feed rather than the reel — it is
 * managed, not consumed. Saved media still goes straight to `/viewer`.
 */
export function profileMediaFeedHref({
  source,
  initialId,
  scope,
}: {
  source: PreviewViewerSource;
  initialId: string;
  /** The Posts tab's scope the tile was tapped in, so the feed holds the same posts. */
  scope?: 'active' | 'archived';
}) {
  return {
    pathname: '/profile-media-feed',
    params: {
      source,
      initialId,
      ...(scope ? { scope } : {}),
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
  owner: { creatorLabel: string; creatorAvatar?: string | null; creatorId?: string | null }
) {
  return items.map((item) => ownerPostToImmersiveItem(source, item, owner));
}

export function getImmersiveInitialIndex(items: ImmersivePreviewItem[], initialId: string | null | undefined) {
  if (!initialId) return 0;
  const index = items.findIndex((item) => item.id === initialId);
  return index >= 0 ? index : 0;
}

/**
 * Whether the item a route asked for is absent from what loaded.
 *
 * `getImmersiveInitialIndex` answers 0 for a missing id, which suits a list's
 * scroll props and nothing else: a screen that let that 0 stand opened the first
 * item in place of the one tapped (audit C1). A missing selection has to be
 * shown as missing — deleted, archived elsewhere, or no longer the reader's.
 */
export function isImmersiveSelectionMissing(items: ImmersivePreviewItem[], initialId: string | null | undefined) {
  return Boolean(initialId) && !items.some((item) => item.id === initialId);
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

/**
 * Whether this slide can make a sound — the cover may be an image while a later
 * page of the same post is a video, and the reel's mute control has to be there
 * before the reader swipes onto it rather than appearing under their thumb.
 */
export function hasImmersiveAudibleMedia(item: ImmersivePreviewItem | undefined) {
  if (!item) return false;
  if (isImmersiveVideoItem(item)) return true;
  return (item.mediaItems ?? []).some((mediaItem) => (
    mediaItem.mediaKind === 'video' && Boolean(mediaItem.url)
  ));
}

/**
 * What a slide with no media says for itself.
 *
 * A creation reaches the reel with nothing to play in two ordinary ways: the
 * run failed, or it has not finished yet. Both used to render as a bare
 * details page, which said nothing about either and -- because the reel treats
 * an open details page as an overlay -- could not be scrolled or backed out
 * of. Saying it plainly is both the honest answer and the thing that gives the
 * slide a page to sit on.
 */
export function getImmersiveStatusSlide(item: ImmersivePreviewItem): { title: string; body: string } {
  const label = item.badge?.toLowerCase() || 'creation';

  if (item.availability === 'source-unavailable') {
    return {
      title: 'This file is no longer available',
      body: `The ${label}'s only copy expired at the provider before it could be saved. The prompt is on the next page — swipe left to read it, or make it again.`,
    };
  }

  if (item.runStatus === 'failed') {
    return {
      title: 'This render failed',
      body: `No ${label} came back from the model, so there is nothing to play here. The prompt is on the next page — swipe left to read it, or start it again from Create.`,
    };
  }

  if (item.runStatus === 'processing' || item.runStatus === 'waiting') {
    return {
      title: 'Still rendering',
      body: `This ${label} is still being made. It will play here once the model returns it.`,
    };
  }

  return {
    title: 'No media to show',
    body: `This ${label} has no playable file. Swipe left for its details.`,
  };
}

export function hasImmersiveDetailsPage(item: ImmersivePreviewItem) {
  // Generations were excluded while they rendered in the separate card screen, which
  // showed their model/cost metadata inline. Now that every source opens the reel,
  // the details page is the only place that metadata can live.
  return Boolean(item.details);
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
  previewUrl?: string | null,
  descriptor?: GenerationListItem['media'],
): ShowcaseMediaItem[] {
  if (!mediaKind) return [];
  const urls = outputUrls?.length ? outputUrls : outputUrl ? [outputUrl] : [];
  return urls.map((url, index) => {
    // A generation descriptor belongs to one output. Attaching it to every
    // slide (or simply the first) would play the wrong clip in multi-output runs.
    const media = descriptor?.url === url && descriptor.kind === mediaKind ? descriptor : undefined;
    const legacyPreview = !descriptor && index === 0 ? previewUrl : null;
    return {
      id: outputUrls?.length ? `${id}:${index}` : `${id}:output`,
      url,
      // The display rendition travels with the descriptor it belongs to. Left on
      // `preview` alone it never reached `getShowcaseViewerImageUrl`, which reads
      // the item, so every creation opened its full-size original (audit C2).
      ...(media && mediaKind === 'image' && media.displayUrl ? { displayUrl: media.displayUrl } : {}),
      preview: media,
      previewUrl: media?.previewUrl ?? legacyPreview ?? (mediaKind === 'image' ? url : null),
      previewThumbhash: media?.thumbhash,
      previewCacheKey: media?.cacheKey,
      mediaKind,
      contentType: null,
      originalName: null,
      width: media?.width ?? null,
      height: media?.height ?? null,
      durationSeconds: media?.durationSeconds ?? null,
      sortOrder: index,
    };
  });
}

function showcaseToImmersiveItem(source: PreviewViewerSource, item: ShowcaseFeedItem): ImmersivePreviewItem {
  const displayText = getShowcasePostDisplayText(item);
  const title = item.title.trim() || item.prompt.trim() || displayText;
  const textOnly = isTextOnlyShowcasePost(item);
  const creatorLabel = creatorHandle(item.creator.username, item.creator.name);
  const isSaved = Boolean(item.isSaved) || source === 'profile-saved';
  const canRecreate = canRecreateShowcaseItem(item);
  const canUnlockRemix = canUnlockRemixShowcaseItem(item);

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
    creatorId: item.creator.id,
    creatorUsername: item.creator.username?.trim() || null,
    createdAt: item.createdAt ?? null,
    badge: showcaseBadge(item),
    // Verb until there is real social proof — a young post reads "Save", not "0".
    saveLabel: item.saveCount > 0 ? formatCompactCount(item.saveCount) : 'Save',
    saveCount: item.saveCount,
    commentLabel: formatCompactCount(item.commentCount),
    commentCount: item.commentCount ?? 0,
    canComment: true,
    isSaved,
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
      toolLabel: item.sourceTool?.trim() || null,
      creatorLabel,
      creatorAvatar: item.creator.avatar,
      saveCount: item.saveCount,
      remixCount: item.remixCount,
      unlock: item.asset ? {
        resourceId: item.asset.id,
        postId: item.asset.postId || item.id,
        title: item.asset.title.trim() || title,
        accessMode: item.asset.accessMode,
        // In credits, as the unlock is paid: never the web checkout's cash quote.
        priceLabel: item.asset.accessMode === 'free'
          ? 'Free'
          : formatUnlockCreditPrice(item.asset.priceUsdCents),
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
    availableActions: [
      isSaved ? 'unsave' : 'save',
      'comment',
      'share',
      ...(canRecreate ? ['recreate'] : []),
      ...(canUnlockRemix ? ['unlock-remix'] : []),
      'view-details',
      'open-original',
    ],
    disabledActions: {},
    recommendation: item.recommendation,
  };
}

function generationToImmersiveItem(
  source: PreviewViewerSource,
  item: GenerationListItem,
  owner: { creatorLabel: string; creatorAvatar?: string | null },
  ownerPosts: OwnerPostListItem[]
): ImmersivePreviewItem {
  const kind = getGenerationKind(item);
  const displayText = item.prompt?.trim() || item.description?.trim() || item.title?.trim() || 'Saved Magicbooklet generation.';
  const title = item.title?.trim() || displayText;
  const mediaKind = getGenerationRenderableMediaKind(kind);
  const previewUrl = item.previewUrl ?? item.preview_url ?? null;
  const linkedPost = findLinkedOwnerPost(item, ownerPosts);
  const linkedPostId = linkedPost?.id ?? item.linked_post_id ?? null;
  const linkedPostVisibility = linkedPost?.visibility ?? item.linked_post_visibility ?? null;
  const linkedPostArchivedAt = linkedPost?.archivedAt ?? item.linked_post_archived_at ?? null;
  const linkedPostPath = linkedPost?.publicPath
    ?? (linkedPostId && linkedPostVisibility !== 'private' && !linkedPostArchivedAt ? `/showcase/${linkedPostId}` : null);
  const linkedPostOwnerPath = linkedPost?.ownerPath ?? (linkedPostId ? `/post/${linkedPostId}/edit` : null);
  // Sharing an unposted creation means publishing it first, which a run that
  // produced no media cannot do. The rail reads `canShare` rather than
  // `availableActions`, so the two have to agree.
  const hasOutput = Boolean(item.output_url || item.output_urls?.length);

  return {
    id: item.id,
    source,
    sourceType: 'generation',
    title,
    displayText,
    mediaUrl: item.output_urls?.[0] ?? item.output_url ?? null,
    mediaKind,
    mediaItems: getGenerationMediaItemsList(item.id, item.output_urls, item.output_url, mediaKind, previewUrl, item.media),
    previewKind: kind === 'text' ? 'text' : undefined,
    creatorLabel: owner.creatorLabel,
    creatorAvatar: owner.creatorAvatar ?? null,
    createdAt: item.created_at ?? null,
    badge: getGenerationLabel(kind),
    saveLabel: 'Saved',
    saveCount: 0,
    commentLabel: '0',
    commentCount: 0,
    canComment: false,
    isSaved: true,
    canSave: false,
    canShare: hasOutput,
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
      categoryLabel: getGenerationLabel(kind),
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
    linkedPostDetailsLoaded: Boolean(linkedPost),
    linkedPostPath,
    linkedPostOwnerPath,
    archivedAt: item.archived_at ?? null,
    runStatus: item.status ?? null,
    availability: getCreationAvailability(item),
    visibility: null,
    availableActions: getGenerationAvailableActions(item, linkedPostId, linkedPostArchivedAt),
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
  linkedPostArchivedAt: string | null
) {
  if (item.archived_at) {
    return ['restore', 'view-details'];
  }

  // A run that produced nothing has nothing to publish or share. It reaches
  // the reel when its own "your video failed" notification is tapped, and the
  // only thing worth offering there is another go at the prompt.
  if (!item.output_url && !item.output_urls?.length) {
    return ['recreate', 'archive', 'view-details'];
  }

  if (!linkedPostId) {
    return ['publish', 'recreate', 'archive', 'share', 'view-details'];
  }

  // The linked post gets the same three-state control as a post of its own;
  // the old public/private toggle could not reach unlisted from here.
  const linkedActions = ['edit-linked-resources'];
  if (!linkedPostArchivedAt) {
    linkedActions.push('change-linked-visibility');
  }

  return [...linkedActions, 'view-linked', 'recreate', 'archive', 'share', 'view-details'];
}

function ownerPostToImmersiveItem(
  source: PreviewViewerSource,
  item: OwnerPostListItem,
  owner: { creatorLabel: string; creatorAvatar?: string | null; creatorId?: string | null }
): ImmersivePreviewItem {
  const textOnly = (item.category === 'text' || item.postFormat === 'text') && !item.mediaUrl;
  const displayText = item.body?.trim() || item.prompt?.trim() || item.title.trim() || 'Community post';
  const prompt = item.prompt?.trim() || item.body?.trim() || item.description?.trim() || item.title.trim();
  const title = item.title.trim() || displayText;
  const isManualOwnerPost = item.generationId == null;
  // Every owned post can be deleted; the server handles a creation post the
  // same way as an upload (including the second step when buyers exist).
  const deleteActions = ['delete-post'];
  const activeGeneratedPostActions = isManualOwnerPost ? [] : ['recreate'];

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
    creatorId: owner.creatorId ?? null,
    createdAt: item.createdAt ?? null,
    badge: ownerPostBadge(item),
    saveLabel: 'Save',
    saveCount: 0,
    commentLabel: formatCompactCount(item.commentCount),
    commentCount: item.commentCount,
    canComment: item.visibility === 'public' && !item.archivedAt,
    isSaved: false,
    canSave: false,
    canShare: true,
    sharePath: item.publicPath ?? null,
    recreateTool: toolForOwnerPost(item),
    recreatePrompt: prompt,
    showcasePostId: item.id,
    generationId: item.generationId ?? null,
    ownerPostId: item.id,
    isManualOwnerPost,
    resource: ownerPostResource(item, displayText),
    details: {
      title,
      prompt: item.prompt?.trim() ?? '',
      body: item.body?.trim() || item.description?.trim() || '',
      categoryLabel: categoryLabel(item.category, item.postFormat),
      sourceLabel: item.sourceLabel?.trim() || 'Post',
      toolLabel: item.sourceLabel?.trim() || null,
      creatorLabel: owner.creatorLabel,
      creatorAvatar: owner.creatorAvatar ?? null,
      saveCount: 0,
      remixCount: 0,
      unlock: item.bundle ? {
        resourceId: item.bundle.id,
        postId: item.id,
        title,
        accessMode: item.bundle.accessMode,
        priceLabel: item.bundle.accessMode === 'free' ? 'Free' : formatUnlockCreditPrice(item.bundle.priceUsdCents),
        previewText: null,
        resourceKinds: normalizeResourceKinds(item.bundle.resourceKinds),
        allowRemix: item.bundle.resourceKinds.includes('remix'),
      } : null,
    },
    linkedPostId: null,
    linkedPostTitle: null,
    linkedPostVisibility: null,
    ownerPostBundle: item.bundle ?? null,
    archivedAt: item.archivedAt ?? null,
    visibility: item.visibility,
    availableActions: item.archivedAt
      ? ['restore', ...deleteActions, 'share', 'download', 'view-details']
      : ['edit-post', 'change-visibility', 'archive', ...deleteActions, 'share', 'download', ...activeGeneratedPostActions, 'view-details'],
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

function hasAppGenerationId(generationId: string | null | undefined) {
  return typeof generationId === 'string' && generationId.trim().length > 0;
}

function canRecreateShowcaseItem(item: ShowcaseFeedItem) {
  return hasAppGenerationId(item.generationId) && item.canRemix;
}

function canUnlockRemixShowcaseItem(item: ShowcaseFeedItem) {
  return (
    hasAppGenerationId(item.generationId)
    && !item.canRemix
    && item.asset?.accessMode === 'paid'
    && Boolean(item.asset.allowRemix)
  );
}

function showcaseBadge(item: ShowcaseFeedItem) {
  if (item.asset?.accessMode === 'free') return 'Free unlock';
  if (item.asset) return formatUnlockCreditPrice(item.asset.priceUsdCents);
  if (canRecreateShowcaseItem(item)) return 'Remix';
  if (item.category === 'text' || item.postFormat === 'text') return 'Prompt';
  if (item.creationMode === 'motion') return 'Motion';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  return 'Image';
}

function ownerPostBadge(item: OwnerPostListItem) {
  if (item.bundle?.accessMode === 'free') return 'Free unlock';
  if (item.bundle?.accessMode === 'paid') return 'Paid unlock';
  if (item.category === 'text' || item.postFormat === 'text') return 'Prompt';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  return 'Post';
}

function categoryLabel(
  category: ShowcaseFeedItem['category'] | OwnerPostListItem['category'] | undefined,
  postFormat?: ShowcaseFeedItem['postFormat'] | OwnerPostListItem['postFormat']
) {
  if (category === 'text' || postFormat === 'text') return 'Prompt';
  if (category === 'video') return 'Video';
  return 'Image';
}

function normalizeResourceKinds(kinds: Array<string | PostResourceKind> | null | undefined): PostResourceKind[] {
  const allowed = new Set<PostResourceKind>(['prompt', 'workflow', 'files', 'notes', 'remix']);
  return (kinds ?? []).filter((kind): kind is PostResourceKind => allowed.has(kind as PostResourceKind));
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

function toolForShowcaseItem(item: ShowcaseFeedItem): CreatorToolId {
  if (item.creationMode === 'motion') return 'motion';
  if (item.category === 'video') return 'video';
  return 'image';
}

function toolForOwnerPost(item: OwnerPostListItem): CreatorToolId {
  if (item.category === 'video' || item.mediaKind === 'video') return 'video';
  return 'image';
}
