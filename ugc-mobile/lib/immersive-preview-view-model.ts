import type { CreatorToolId, GenerationListItem, OwnerPostListItem, PostResourceKind, ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/types';

import { withAppleZoom, type AppleZoomOpen } from './apple-zoom';
import { getCreationAvailability, type CreationAvailability } from './creation-library';
import {
  getGenerationKind,
  getGenerationLabel,
  getGenerationRenderableMediaKind,
  normalizeGenerationAudioKind,
  type GenerationAudioKind,
  type GenerationMediaKind,
} from './generation-media';
import { UNKNOWN_CREATOR_LABEL } from './hide-creator-label';
import { formatCompactCount } from './home-view-model';
import { formatReturnedCredits, type PostDetailsSection } from './post-details-view-model';
import { FREE_RECIPE_LABEL, formatUnlockCreditPrice } from './pricing';
import { getShowcasePostDisplayText, isTextOnlyShowcasePost } from './showcase-display';
import { getShowcaseRemixAccess, type ShowcaseRemixAccess } from './showcase-remix-access';

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
  /**
   * The id of the model the post was made with, as the feed sends it
   * (`ShowcaseFeedItem.model`: a catalog id, `manual`, or an outside tool's).
   * Details names it by its display name and never prints the id.
   */
  model?: string | null;
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
    /** The run failed and `cost` came back to the creator. */
    refunded?: boolean;
    /** Why a failed run failed, in the server's public words. */
    failureReason?: string | null;
    /**
     * How many files the run made, when it made more than one
     * (`getGenerationOutputCount`). The slide shows the first; the details
     * page reads the full record to list them all.
     */
    outputCount?: number | null;
    inputMedia: Array<{ url?: string | null; kind?: string | null }> | null;
  } | null;
}

/**
 * The sound of an audio creation. It travels apart from `mediaUrl` and
 * `mediaItems`, which picture and video components read: a sound file's
 * address must never reach one of them.
 */
export interface ImmersivePreviewAudio {
  url: string;
  kind: GenerationAudioKind;
  /** The length the run was asked for, when it was asked for one; the player reports the real one. */
  durationSeconds: number | null;
}

export interface ImmersivePreviewItem {
  isNsfw?: boolean;
  nsfwRevealed?: boolean;
  id: string;
  source: PreviewViewerSource;
  sourceType: ImmersivePreviewSourceType;
  title: string;
  displayText: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  mediaItems: ShowcaseMediaItem[];
  /** A slide that is words, or sound, rather than a picture or video. */
  previewKind?: 'text' | 'audio';
  /** Present exactly when `previewKind` is `audio`. */
  audio?: ImmersivePreviewAudio | null;
  /** What kind of creation a generation is; unset for posts. */
  creationKind?: GenerationMediaKind;
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
  /**
   * For someone else's post: what a tap on Remix has to get through first
   * (lib/showcase-remix-access.ts). `free-unlock` still offers `recreate`, and
   * the tap claims the unlock on its way to the editor.
   */
  remixAccess?: ShowcaseRemixAccess | null;
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
  /**
   * Moderation took the creation down. It is archived as well, can be deleted
   * but not restored, and its media is not drawn anywhere: its slide says why.
   */
  moderationRemoved?: boolean;
  /**
   * Set on a template's output: the run that made it, which owns it, and how a
   * run that did not succeed ended. Such a run's finished steps are listed but
   * cannot be posted.
   */
  templateRun?: { runId: string | null; endedAs: 'cancelled' | 'failed' | null } | null;
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
  lane,
  mediaOnly,
  source,
  initialId,
  initialPage,
  initialSection,
  zoom = null,
}: {
  algorithmVersion?: string | null;
  creatorUsername?: string | null;
  feedSessionId?: string | null;
  /** The grid lane the tile was in (`serializeShowcaseFeedLane`): the reel reads and pages it. */
  lane?: string | null;
  mediaOnly?: boolean;
  source: PreviewViewerSource;
  initialId: string;
  /** Read more opens the previewed text on the existing Details page; a recipe chip, the recipe. */
  initialPage?: 'details';
  initialSection?: PostDetailsSection;
  /** The zoom the tapped tile hands the push on iOS 18 (lib/apple-zoom.ts). */
  zoom?: AppleZoomOpen | null;
}) {
  return withAppleZoom({
    pathname: '/viewer',
    params: {
      source,
      initialId,
      ...(initialPage ? { initialPage } : {}),
      ...(initialSection ? { initialSection } : {}),
      ...(mediaOnly ? { mediaOnly: '1' } : {}),
      ...(feedSessionId ? { feedSessionId } : {}),
      ...(algorithmVersion ? { algorithmVersion } : {}),
      ...(creatorUsername ? { creatorUsername } : {}),
      ...(lane ? { lane } : {}),
    },
  }, zoom);
}

export function textPostViewerHref({
  comments = false,
  deliveryId,
  initialPage,
  initialSection,
  postId,
  source,
}: {
  comments?: boolean;
  /**
   * The feed delivery the post was opened from, for the comments written on
   * its screen to be credited to (Home's text cards). Opaque to the screen.
   */
  deliveryId?: string | null;
  /**
   * The post's Details page, and the part of it to lead with: a recipe chip
   * opens the recipe (audit B-F6), as it does over the reel. A section without
   * the page asks for nothing.
   */
  initialPage?: 'details';
  initialSection?: PostDetailsSection;
  postId: string;
  source?: 'profile-posts' | 'profile-saved';
}) {
  const pathname = `/post/${encodeURIComponent(postId)}`;
  const params = [
    ...(source ? [['source', source]] : []),
    ...(comments ? [['comments', postId]] : []),
    ...(deliveryId ? [['deliveryId', deliveryId]] : []),
    ...(initialPage ? [['page', initialPage]] : []),
    ...(initialPage && initialSection ? [['section', initialSection]] : []),
  ];
  return params.length
    ? `${pathname}?${params
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&')}`
    : pathname;
}

export function immersivePreviewOpenHref(
  item: ImmersivePreviewItem,
  options: { comments?: boolean; initialPage?: 'details'; initialSection?: PostDetailsSection; zoom?: AppleZoomOpen | null } = {}
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

  return immersiveViewerHref({ source: item.source, initialId: item.id, initialPage: options.initialPage, initialSection: options.initialSection, zoom: options.zoom });
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
  lane,
  mediaOnly,
  item,
  source,
  zoom,
}: {
  algorithmVersion?: string | null;
  comments?: boolean;
  creatorUsername?: string | null;
  feedSessionId?: string | null;
  lane?: string | null;
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
    lane,
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
  lane,
  mediaOnly,
  source,
  initialId,
}: {
  algorithmVersion?: string | null;
  creatorUsername?: string | null;
  feedSessionId?: string | null;
  lane?: string | null;
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
    ...(lane ? [['lane', lane]] : []),
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

export function buildImmersiveShowcaseItems(
  source: PreviewViewerSource,
  items: ShowcaseFeedItem[],
  /** The signed-in viewer, so their own post can offer Edit post. */
  viewerUserId: string | null = null,
) {
  return items.map((item) => showcaseToImmersiveItem(source, item, viewerUserId));
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

  if (item.moderationRemoved) {
    return {
      title: 'Removed by moderation',
      body: `Our moderation team removed this ${label}. It can’t be shown or restored, but you can delete it.`,
    };
  }

  if (item.availability === 'source-unavailable') {
    return {
      title: 'This file is no longer available',
      body: `The ${label}'s only copy expired at the provider before it could be saved. The prompt is on the next page — swipe left to read it, or make it again.`,
    };
  }

  if (item.runStatus === 'failed') {
    // Audio is made by workflow steps on the web; the app has no tool to start
    // it again from.
    const again = item.creationKind === 'audio'
      ? 'run its workflow again on magicbooklet.com'
      : 'start it again from Create';
    const info = item.details?.generationInfo;
    // The row keeps its cost after a refund, so the slide says what came back,
    // and first: a long reason can run past the slide's lines, and a refund cut
    // off there would leave the run reading as paid for.
    const returned = formatReturnedCredits(info);
    const opening = returned ? `${returned}. ` : '';
    const reason = info?.failureReason?.trim();
    return {
      title: 'This render failed',
      body: reason
        ? `${opening}${reason}`
        : `${opening}No ${label} came back from the model, so there is nothing to play here. The prompt is on the next page — swipe left to read it, or ${again}.`,
    };
  }

  // `pending` is in flight too: a run the provider has not picked up yet.
  if (item.availability === 'rendering' || item.runStatus === 'processing' || item.runStatus === 'waiting') {
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

/**
 * The reel rail's Remix where a paid unlock stands in front of it: the price
 * where "Remix" would be, with the lock, as the Home card's pill draws it
 * (`remixLabel` in lib/home-feed-view-model.ts), so the sheet the tap opens is
 * no surprise (audit B-F15). Null for a Remix that opens.
 */
export function getLockedRemixRailLabel(
  item: Pick<ImmersivePreviewItem, 'title' | 'details' | 'availableActions'>
): { label: string; accessibilityLabel: string } | null {
  if (!item.availableActions.includes('unlock-remix')) return null;
  const unlock = item.details?.unlock;
  const price = unlock?.accessMode === 'paid' ? unlock.priceLabel.trim() : '';
  return {
    label: price || 'Remix',
    accessibilityLabel: `Unlock ${item.title} to remix it${price ? `, ${price}` : ''}`,
  };
}

export function hasImmersiveDetailsPage(item: ImmersivePreviewItem) {
  // Generations were excluded while they rendered in the separate card screen, which
  // showed their model/cost metadata inline. Now that every source opens the reel,
  // the details page is the only place that metadata can live.
  return Boolean(item.details);
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

function showcaseToImmersiveItem(
  source: PreviewViewerSource,
  item: ShowcaseFeedItem,
  viewerUserId: string | null = null,
): ImmersivePreviewItem {
  const displayText = getShowcasePostDisplayText(item);
  const title = item.title.trim() || item.prompt.trim() || displayText;
  const textOnly = isTextOnlyShowcasePost(item);
  const creatorLabel = creatorHandle(item.creator.username, item.creator.name);
  const isSaved = Boolean(item.isSaved) || source === 'profile-saved';
  const remixAccess = getShowcaseRemixAccess(item);
  // A paid unlock is the one case that needs its own action: it opens a sheet
  // before anything is spent. A free one is claimed by the Remix tap itself.
  const canUnlockRemix = remixAccess === 'paid-unlock';
  const canRecreate = remixAccess === 'open' || remixAccess === 'free-unlock';
  // The server takes comments on public posts only.
  const canComment = item.visibility !== 'unlisted';

  return {
    id: item.id,
    source,
    sourceType: 'showcase',
    isNsfw: item.isNsfw,
    nsfwRevealed: item.nsfwRevealed,
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
    badge: showcaseBadge(item, viewerUserId),
    // Verb until there is real social proof — a young post reads "Save", not "0".
    saveLabel: item.saveCount > 0 ? formatCompactCount(item.saveCount) : 'Save',
    saveCount: item.saveCount,
    commentLabel: formatCompactCount(item.commentCount),
    commentCount: item.commentCount ?? 0,
    canComment,
    isSaved,
    canSave: true,
    canShare: true,
    sharePath: `/showcase/${item.id}`,
    recreateTool: toolForShowcaseItem(item),
    recreatePrompt: item.prompt.trim() || item.body.trim() || item.title.trim(),
    remixAccess,
    showcasePostId: item.id,
    generationId: item.generationId,
    ownerPostId: null,
    resource: showcaseResource(item),
    details: {
      title,
      prompt: item.prompt.trim(),
      // A caption written in the web composer's description field, on a post
      // with no body, is still the post's story; the owner view reads it the
      // same way.
      body: item.body.trim() || item.description?.trim() || '',
      categoryLabel: categoryLabel(item.category, item.postFormat),
      sourceLabel: 'Showcase',
      toolLabel: item.sourceTool?.trim() || null,
      model: item.model ?? null,
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
    visibility: item.visibility ?? 'public',
    availableActions: [
      // The creator reaches their own post from the feed, a link or an alert as
      // often as from Profile; the web post page offers Edit there too.
      ...(viewerUserId && item.creator.id === viewerUserId ? ['edit-post'] : []),
      isSaved ? 'unsave' : 'save',
      // The rail's own rule: a row on a post that takes no comments did nothing.
      ...(canComment ? ['comment'] : []),
      'share',
      ...(canRecreate ? ['recreate'] : []),
      ...(canUnlockRemix ? ['unlock-remix'] : []),
      'view-details',
    ],
    disabledActions: {},
    recommendation: item.recommendation,
  };
}

/**
 * How many files a run made, when it made more than one that can still be
 * opened; null otherwise. The library is read with `detail=summary`, which
 * sends this count and only the first output's addresses, so the others were
 * out of reach until something said they were there. Moderation takes down
 * every file of a removed creation, and one whose source is gone has none
 * left to open.
 */
export function getGenerationOutputCount(
  item: Pick<GenerationListItem, 'output_count' | 'output_urls' | 'moderation_removed_at' | 'source_unavailable_at'>
): number | null {
  if (item.moderation_removed_at || item.source_unavailable_at) return null;
  const count = Math.max(item.output_count ?? 0, item.output_urls?.length ?? 0);
  return count > 1 ? count : null;
}

/** The web Studio's words for a run of several files, "3 outputs"; null for a run of one. */
export function formatOutputCount(count: number | null | undefined): string | null {
  return count && count > 1 ? `${count} outputs` : null;
}

function generationToImmersiveItem(
  source: PreviewViewerSource,
  item: GenerationListItem,
  owner: { creatorLabel: string; creatorAvatar?: string | null },
  ownerPosts: OwnerPostListItem[]
): ImmersivePreviewItem {
  const kind = getGenerationKind(item);
  const templateRun = generationTemplateRun(item);
  // A template's output carries no prompt (the recipe is the template's), so it
  // is named by its template and described by its run.
  const templateTitle = templateRun ? item.template?.templateTitle?.trim() || 'Template result' : null;
  const templateSummary = templateRun
    ? templateRun.endedAs
      ? `A finished step of a template run that was ${templateRun.endedAs}. Open the run to see every step.`
      : 'Made with a template. Open the run to see every step.'
    : null;
  const displayText = item.prompt?.trim() || item.description?.trim() || templateSummary || item.title?.trim() || 'Saved Magicbooklet generation.';
  const title = item.title?.trim() || templateTitle || displayText;
  const mediaKind = getGenerationRenderableMediaKind(kind);
  const previewUrl = item.previewUrl ?? item.preview_url ?? null;
  const linkedPost = findLinkedOwnerPost(item, ownerPosts);
  const linkedPostId = linkedPost?.id ?? item.linked_post_id ?? null;
  const linkedPostVisibility = linkedPost?.visibility ?? item.linked_post_visibility ?? null;
  const linkedPostArchivedAt = linkedPost?.archivedAt ?? item.linked_post_archived_at ?? null;
  const linkedPostPath = linkedPost?.publicPath
    ?? (linkedPostId && linkedPostVisibility !== 'private' && !linkedPostArchivedAt ? `/showcase/${linkedPostId}` : null);
  const linkedPostOwnerPath = linkedPost?.ownerPath ?? (linkedPostId ? `/post/${linkedPostId}/edit` : null);
  // A creation is shared as its post: the link to a public or unlisted one,
  // which is what the web's "Copy post link" sends. Without such a post there
  // is no link yet (Publish, or the visibility control, is the way to one), and
  // an archived creation is out of the library until it is restored. The rail
  // reads `canShare` rather than `availableActions`, so the two have to agree,
  // and a creation with no file left offers none of its post's controls.
  const hasOutput = Boolean(item.output_url || item.output_urls?.length);
  const sharePath = linkedPostId
    && (linkedPostVisibility === 'public' || linkedPostVisibility === 'unlisted')
    && !linkedPostArchivedAt
    ? linkedPostPath
    : null;
  const canShare = Boolean(sharePath) && hasOutput && !item.archived_at;
  const isAudio = kind === 'audio';
  const outputUrl = item.output_urls?.[0] ?? item.output_url ?? null;
  const availability = getCreationAvailability(item);
  const moderationRemoved = Boolean(item.moderation_removed_at);
  // Only a finished audio creation with its file has something to play. One
  // that failed, is still rendering or lost its file sits on the status page
  // like any other creation in that state.
  const audio: ImmersivePreviewAudio | null = isAudio && availability === 'available' && outputUrl && !moderationRemoved
    ? {
        url: outputUrl,
        kind: normalizeGenerationAudioKind(item.audioKind),
        durationSeconds: typeof item.duration === 'number' && item.duration > 0 ? item.duration : null,
      }
    : null;
  const label = getGenerationLabel(kind, item.audioKind);

  return {
    id: item.id,
    source,
    sourceType: 'generation',
    title,
    displayText,
    // What moderation took down is not drawn: its status page says why.
    mediaUrl: isAudio || moderationRemoved ? null : outputUrl,
    mediaKind,
    mediaItems: moderationRemoved
      ? []
      : getGenerationMediaItemsList(item.id, item.output_urls, item.output_url, mediaKind, previewUrl, item.media),
    previewKind: moderationRemoved ? undefined : kind === 'text' ? 'text' : audio ? 'audio' : undefined,
    audio,
    creationKind: kind,
    creatorLabel: owner.creatorLabel,
    creatorAvatar: owner.creatorAvatar ?? null,
    createdAt: item.created_at ?? null,
    badge: label,
    saveLabel: 'Saved',
    saveCount: 0,
    commentLabel: '0',
    commentCount: 0,
    canComment: false,
    isSaved: true,
    canSave: false,
    canShare,
    sharePath,
    // Unread for audio, which never offers `recreate`: no create tool takes it.
    recreateTool: kind === 'motion' ? 'motion' : kind === 'video' ? 'video' : 'image',
    recreatePrompt: item.prompt?.trim() || item.description?.trim() || item.title?.trim() || '',
    showcasePostId: linkedPostId,
    generationId: item.id,
    ownerPostId: null,
    details: {
      title,
      prompt: item.prompt?.trim() ?? '',
      body: item.description?.trim() ?? '',
      categoryLabel: label,
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
        refunded: item.refunded === true,
        failureReason: item.error_message?.trim() || null,
        outputCount: getGenerationOutputCount(item),
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
    availability,
    moderationRemoved,
    templateRun,
    visibility: null,
    availableActions: getGenerationAvailableActions(item, {
      availability,
      canShare,
      isAudio,
      linkedPostArchivedAt,
      linkedPostId,
      templateRun,
    }),
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

/** The run a template's output came from, or null for an ordinary creation. */
function generationTemplateRun(item: GenerationListItem): ImmersivePreviewItem['templateRun'] {
  if (item.origin !== 'template') return null;
  const runStatus = item.template?.runStatus;
  return {
    runId: item.template?.runId?.trim() || null,
    endedAs: runStatus === 'cancelled' || runStatus === 'failed' ? runStatus : null,
  };
}

function getGenerationAvailableActions(
  item: GenerationListItem,
  {
    availability,
    canShare,
    isAudio,
    linkedPostArchivedAt,
    linkedPostId,
    templateRun,
  }: {
    availability: CreationAvailability;
    canShare: boolean;
    isAudio: boolean;
    linkedPostArchivedAt: string | null;
    linkedPostId: string | null;
    templateRun: ImmersivePreviewItem['templateRun'];
  }
) {
  // A template's output belongs to its run: the server refuses to recreate,
  // archive, restore or delete it (`generation-lifecycle-service.ts`,
  // `generation-delete-service.ts`), and the run is where it is managed.
  const openRun = templateRun?.runId ? ['open-run'] : [];
  // Delete is final and the server keeps no undo. A run still rendering holds
  // its credits until it settles, and only the row can settle it, so it is not
  // offered until the run has.
  const remove = templateRun || availability === 'rendering' ? [] : ['delete-creation'];

  if (item.archived_at) {
    // Moderation archives what it takes down, and Restore refuses it.
    return [...(item.moderation_removed_at || templateRun ? [] : ['restore']), ...remove, 'view-details'];
  }

  // The server answers 400 to publishing, sharing and remixing audio, and the
  // app has no tool that makes it. Offering those led to a composer that could
  // not load the creation and to the image tool holding a voiceover script.
  if (isAudio) {
    return [...(templateRun ? openRun : ['archive']), ...remove, 'view-details'];
  }

  // A run that produced nothing has nothing to publish or share. It reaches
  // the reel when its own "your video failed" notification is tapped, and the
  // only thing worth offering there is another go at the prompt.
  if (!item.output_url && !item.output_urls?.length) {
    return templateRun
      ? [...openRun, 'view-details']
      : ['recreate', 'archive', ...remove, 'view-details'];
  }

  const library = templateRun ? openRun : ['recreate', 'archive', ...remove];
  // Download, as on owned posts and on the web Studio card.
  const tail = [...(canShare ? ['share'] : []), 'download', 'view-details'];

  if (!linkedPostId) {
    // Only a succeeded run's result can be posted (`showcase-publish-service.ts`).
    return [...(templateRun?.endedAs ? [] : ['publish']), ...library, ...tail];
  }

  // The linked post gets the same three-state control as a post of its own;
  // the old public/private toggle could not reach unlisted from here.
  const linkedActions = ['edit-linked-resources'];
  if (!linkedPostArchivedAt) {
    linkedActions.push('change-linked-visibility');
  }

  return [...linkedActions, 'view-linked', ...library, ...tail];
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
  const mediaItems = getMediaItemsList(item.id, item.mediaUrl, item.mediaKind, item.mediaItems);
  // A post of words has no file to save: the row only ever answered "No media file".
  const downloadActions = mediaItems.length ? ['download'] : [];

  return {
    id: item.id,
    source,
    sourceType: 'owner-post',
    title,
    displayText,
    mediaUrl: item.mediaUrl,
    mediaKind: item.mediaKind,
    mediaItems,
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
      ? ['restore', ...deleteActions, 'share', ...downloadActions, 'view-details']
      : ['edit-post', 'change-visibility', 'archive', ...deleteActions, 'share', ...downloadActions, ...activeGeneratedPostActions, 'view-details'],
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
  return name.trim() || UNKNOWN_CREATOR_LABEL;
}

function showcaseBadge(item: ShowcaseFeedItem, viewerUserId: string | null) {
  // A recipe the viewer has is no longer for sale to them (audit B-F2): the
  // feed chip's words, "Your recipe" for the creator, "Unlocked" for a buyer.
  if (item.asset && viewerUserId && item.creator.id === viewerUserId) return 'Your recipe';
  if (item.asset?.viewerHasUnlocked) return 'Unlocked';
  if (item.asset?.accessMode === 'free') return FREE_RECIPE_LABEL;
  if (item.asset) return formatUnlockCreditPrice(item.asset.priceUsdCents);
  if (getShowcaseRemixAccess(item) === 'open') return 'Remix';
  // A text post is "Text", beside Image, Video and Motion (decision 10,
  // 2026-10-17); "Prompt" names a real prompt only.
  if (item.category === 'text' || item.postFormat === 'text') return 'Text';
  if (item.creationMode === 'motion') return 'Motion';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  return 'Image';
}

function ownerPostBadge(item: OwnerPostListItem) {
  if (item.bundle?.accessMode === 'free') return FREE_RECIPE_LABEL;
  if (item.bundle?.accessMode === 'paid') return 'Paid recipe';
  if (item.category === 'text' || item.postFormat === 'text') return 'Text';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  return 'Post';
}

function categoryLabel(
  category: ShowcaseFeedItem['category'] | OwnerPostListItem['category'] | undefined,
  postFormat?: ShowcaseFeedItem['postFormat'] | OwnerPostListItem['postFormat']
) {
  if (category === 'text' || postFormat === 'text') return 'Text';
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
    title: item.asset.title || item.title || item.prompt || 'Recipe',
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
    title: item.title || 'Recipe',
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
