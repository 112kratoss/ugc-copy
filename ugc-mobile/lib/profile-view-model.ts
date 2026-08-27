import type { GenerationListItem, OwnerPostListItem, ProfileResponse, ShowcaseFeedItem } from '@/lib/types';
import type { PreviewViewerSource } from './immersive-preview-view-model';

import { getGenerationKind, getGenerationLabel, getGenerationRenderableMediaKind } from './generation-media';
import { formatCompactCount, formatRelativeTime, formatUsdCents } from './home-view-model';

export type ProfilePreviewState = 'image' | 'videoPoster' | 'videoFallback' | 'text' | 'artFallback';

export interface ProfileMediaCard {
  id: string;
  title: string;
  label: 'Saved' | 'Creation' | 'Post';
  meta: string;
  mediaUrl: string | null;
  previewUrl?: string | null;
  previewThumbhash?: string | null;
  previewCacheKey?: string;
  previewExpiresAt?: string | null;
  previewStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  mediaKind: 'image' | 'video' | null;
  previewKind?: 'text';
  previewText?: string;
  previewState?: ProfilePreviewState;
  previewStatusLabel?: string;
  isGridReady?: boolean;
  isArchived?: boolean;
  badge?: string;
  detailLabel?: string;
  statusLabel?: string;
  linkedPostLabel?: string;
  visibilityLabel?: string;
  mediaTypeLabel?: string;
  avatarUrl?: string | null;
  avatarLabel?: string;
  countLabel?: string;
  viewerSource: PreviewViewerSource;
  sourceId: string;
  artVariant: 'kingdom' | 'city' | 'runner' | 'tree' | 'portal';
  href: string;
}

export interface ProfileStat {
  label: 'Creations' | 'Posts' | 'Saved';
  value: string;
}

export type ProfileMediaTab = 'Saved' | 'Creations' | 'Posts';

/**
 * Where the profile tab opens with no route params. `Creations` because it is
 * the first stat the hero card prints, the first segment of the control below
 * it, and the only one of the three that is the reader's own work -- the screen
 * used to open on media saved from other people.
 */
export const DEFAULT_PROFILE_MEDIA_TAB: ProfileMediaTab = 'Creations';

export type ProfileMediaSwipeDirection = 'left' | 'right';

/**
 * Same order as `getProfileStats` below, which the hero card prints directly
 * above this control. Design principles' Consistency — "once you establish a
 * behavior or appearance for an element, apply it throughout": the counts and
 * the control that switches between the collections they count cannot list
 * them two different ways.
 */
export const PROFILE_MEDIA_TABS: ProfileMediaTab[] = ['Creations', 'Posts', 'Saved'];

export const FALLBACK_PROFILE_MEDIA: ProfileMediaCard[] = [
  {
    id: 'preview-saved-island',
    title: 'Saved Island',
    label: 'Saved',
    meta: 'Preview',
    mediaUrl: null,
    mediaKind: 'image',
    previewState: 'artFallback',
    isGridReady: true,
    avatarLabel: 'Preview',
    countLabel: '0',
    viewerSource: 'profile-saved',
    sourceId: 'preview-saved-island',
    artVariant: 'tree',
    href: '/showcase',
  },
  {
    id: 'preview-crystal-portal',
    title: 'Crystal Portal',
    label: 'Creation',
    meta: 'Preview',
    mediaUrl: null,
    mediaKind: 'image',
    previewState: 'artFallback',
    isGridReady: true,
    avatarLabel: 'Preview',
    countLabel: '0',
    viewerSource: 'profile-creations',
    sourceId: 'preview-crystal-portal',
    artVariant: 'portal',
    href: '/(tabs)/creator',
  },
  {
    id: 'preview-cyber-shot',
    title: 'Cyber Shot',
    label: 'Post',
    meta: 'Preview',
    mediaUrl: null,
    mediaKind: 'video',
    previewState: 'artFallback',
    isGridReady: true,
    avatarLabel: 'Preview',
    countLabel: '0',
    viewerSource: 'profile-posts',
    sourceId: 'preview-cyber-shot',
    artVariant: 'city',
    href: '/seller-dashboard',
  },
];

export function getProfileName(profile: ProfileResponse | null | undefined, email?: string | null) {
  return profile?.displayName?.trim()
    || profile?.username?.trim()
    || profile?.suggestedUsername?.trim()
    || getEmailLocalPart(email)
    || 'Creator';
}

export function getProfileHandle(profile: ProfileResponse | null | undefined, email?: string | null) {
  const handle = profile?.username?.trim() || profile?.suggestedUsername?.trim() || getEmailLocalPart(email) || 'creator';
  return `@${handle.replace(/^@+/, '')}`;
}

export function getProfileInitials(profile: ProfileResponse | null | undefined, email?: string | null) {
  const name = getProfileName(profile, email);
  const words = name
    .replace(/@/g, '')
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter((word) => word && !/^\d+$/.test(word));

  if (words.length === 0) return 'C';
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join('') || 'C';
}

/**
 * Counts reflect what has been paged in so far, so a tab with more pages waiting reads as `24+`
 * rather than claiming a total the server never gave us.
 */
function profileStatValue(count: number, hasMore?: boolean) {
  const value = formatCompactCount(count);
  return hasMore ? `${value}+` : value;
}

export function getProfileStats({
  generationsCount,
  generationsHasMore,
  postsCount,
  postsHasMore,
  savedCount,
  savedHasMore,
}: {
  generationsCount: number;
  generationsHasMore?: boolean;
  postsCount: number;
  postsHasMore?: boolean;
  savedCount: number;
  savedHasMore?: boolean;
}): ProfileStat[] {
  return [
    { label: 'Creations', value: profileStatValue(generationsCount, generationsHasMore) },
    { label: 'Posts', value: profileStatValue(postsCount, postsHasMore) },
    { label: 'Saved', value: profileStatValue(savedCount, savedHasMore) },
  ];
}

export type ProfilePostsScope = 'active' | 'archived';

export function getProfileMediaEmptyTitle(tab: ProfileMediaTab, postsScope: ProfilePostsScope = 'active') {
  if (tab === 'Saved') return 'No saved media yet';
  if (tab === 'Creations') return 'No creations yet';
  return postsScope === 'archived' ? 'No archived posts' : 'No posts yet';
}

export function getProfileMediaSwipeTarget(currentTab: ProfileMediaTab, direction: ProfileMediaSwipeDirection) {
  const currentIndex = PROFILE_MEDIA_TABS.indexOf(currentTab);
  if (currentIndex === -1) return currentTab;

  const targetIndex = direction === 'left'
    ? Math.min(PROFILE_MEDIA_TABS.length - 1, currentIndex + 1)
    : Math.max(0, currentIndex - 1);

  return PROFILE_MEDIA_TABS[targetIndex] ?? currentTab;
}

export function generationToProfileMediaCard(item: GenerationListItem): ProfileMediaCard {
  const kind = getGenerationKind(item);
  const mediaKind = getGenerationRenderableMediaKind(kind);
  const mediaUrl = item.media?.url ?? item.output_urls?.[0] ?? item.output_url ?? null;
  const posterUrl = item.media?.previewUrl ?? item.previewUrl ?? item.preview_url ?? null;
  const previewUrl = mediaKind === 'image' ? posterUrl ?? mediaUrl : posterUrl;
  const previewText = kind === 'text' ? item.prompt || item.description || item.title || 'Saved text generation' : undefined;
  const previewState = getProfilePreviewState({
    mediaKind,
    mediaUrl,
    previewKind: kind === 'text' ? 'text' : undefined,
    previewText,
    previewUrl,
  });
  const isArchived = Boolean(item.archived_at);
  const hasGridContent = kind === 'text' ? Boolean(previewText?.trim()) : Boolean(mediaUrl && posterUrl);
  const derivativeReady = kind === 'text'
    ? hasGridContent
    : item.media?.gridReady ?? Boolean(posterUrl);
  const isGridReady = !isArchived && item.status === 'succeeded' && derivativeReady;
  const label = getGenerationLabel(kind);

  return {
    id: item.id,
    title: item.title || item.prompt || 'Untitled creation',
    label: 'Creation',
    meta: formatRelativeTime(item.completed_at ?? item.created_at),
    mediaUrl,
    previewUrl,
    previewThumbhash: item.media?.thumbhash ?? null,
    previewCacheKey: item.media?.cacheKey ?? posterUrl ?? item.id,
    previewExpiresAt: item.media?.expiresAt ?? null,
    previewStatus: item.media?.status ?? (posterUrl ? 'ready' : 'pending'),
    mediaKind,
    previewKind: kind === 'text' ? 'text' : undefined,
    previewText,
    previewState,
    previewStatusLabel: previewState === 'videoFallback' ? 'Preview unavailable' : undefined,
    isGridReady,
    isArchived,
    badge: label,
    detailLabel: label,
    statusLabel: generationStatusLabel(item.status),
    linkedPostLabel: item.linked_post_id
      ? item.linked_post_archived_at
        ? 'Archived post'
        : item.linked_post_visibility
          ? `${capitalize(item.linked_post_visibility)} post`
          : 'Linked post'
      : 'Not posted',
    countLabel: '0',
    viewerSource: 'profile-creations',
    sourceId: item.id,
    artVariant: kind === 'text' ? 'tree' : kind === 'motion' ? 'runner' : kind === 'video' ? 'city' : 'kingdom',
    href: '/profile',
  };
}

export function ownerPostToProfileMediaCard(item: OwnerPostListItem): ProfileMediaCard {
  const isTextPost = item.category === 'text' || item.postFormat === 'text';
  const primaryMedia = item.mediaItems?.[0];
  const descriptor = primaryMedia?.preview;
  const previewUrl = descriptor?.previewUrl ?? primaryMedia?.previewUrl ?? null;
  const previewText =
    item.body?.trim()
    || item.prompt?.trim()
    || item.description?.trim()
    || item.title
    || 'A creator-ready idea from the Magicbooklet community.';

  return {
    id: item.id,
    title: item.title || 'Untitled post',
    label: 'Post',
    meta: item.visibility || formatRelativeTime(item.createdAt),
    mediaUrl: item.mediaUrl,
    previewUrl,
    previewThumbhash: descriptor?.thumbhash ?? primaryMedia?.previewThumbhash ?? null,
    previewCacheKey: descriptor?.cacheKey ?? primaryMedia?.previewCacheKey ?? previewUrl ?? item.id,
    previewExpiresAt: descriptor?.expiresAt ?? null,
    previewStatus: descriptor?.status ?? primaryMedia?.previewStatus ?? (previewUrl ? 'ready' : 'pending'),
    mediaKind: item.mediaKind,
    previewKind: isTextPost ? 'text' : undefined,
    previewText,
    previewState: getProfilePreviewState({
      mediaKind: item.mediaKind,
      mediaUrl: item.mediaUrl,
      previewKind: isTextPost ? 'text' : undefined,
      previewText,
      previewUrl,
    }),
    previewStatusLabel: item.mediaKind === 'video' && !previewUrl ? 'Preview unavailable' : undefined,
    // An image post whose media lives on `posts.output_url` has no `post_media`
    // row to carry a descriptor, so the old check saw no preview and dropped it
    // -- hiding published posts from the grid entirely while the web profile
    // still listed them. getProfilePreviewState already renders that case from
    // `mediaUrl`, so the filter has to accept it too or it discards tiles the
    // renderer could draw. Videos still require a poster, matching `gridReady`
    // being defined as `mediaKind === 'image'` in showcase-media.
    // Readiness is about whether the tile can be drawn. Whether an archived
    // post belongs in the grid is the grid's call: the Posts tab shows active
    // and archived posts as two scopes, so an archived post must stay
    // renderable rather than be dropped here.
    isGridReady: isTextPost
      ? Boolean(previewText.trim())
      : Boolean(
        (descriptor?.gridReady ?? primaryMedia?.gridReady ?? previewUrl)
        || (item.mediaKind === 'image' && item.mediaUrl),
      ),
    isArchived: Boolean(item.archivedAt),
    badge: ownerPostBadge(item),
    statusLabel: item.archivedAt ? 'Archived' : 'Published',
    visibilityLabel: postVisibilityLabel(item.visibility),
    mediaTypeLabel: ownerPostBadge(item),
    countLabel: '0',
    viewerSource: 'profile-posts',
    sourceId: item.id,
    artVariant: item.bundle ? 'portal' : item.mediaKind === 'video' ? 'city' : isTextPost ? 'tree' : 'kingdom',
    href: `/showcase/${item.id}`,
  };
}

export function showcaseToSavedProfileMediaCard(item: ShowcaseFeedItem): ProfileMediaCard {
  const isTextPost = item.category === 'text' || item.postFormat === 'text';
  const previewText = isTextPost ? item.body || item.prompt || item.title : undefined;
  const primaryMedia = item.mediaItems?.[0];
  const descriptor = primaryMedia?.preview;
  const previewUrl = descriptor?.previewUrl ?? primaryMedia?.previewUrl ?? null;

  return {
    id: item.id,
    title: item.title || item.prompt || 'Saved media',
    label: 'Saved',
    meta: item.creator.name,
    mediaUrl: item.mediaUrl,
    previewUrl,
    previewThumbhash: descriptor?.thumbhash ?? primaryMedia?.previewThumbhash ?? null,
    previewCacheKey: descriptor?.cacheKey ?? primaryMedia?.previewCacheKey ?? previewUrl ?? item.id,
    previewExpiresAt: descriptor?.expiresAt ?? null,
    previewStatus: descriptor?.status ?? primaryMedia?.previewStatus ?? (previewUrl ? 'ready' : 'pending'),
    mediaKind: item.mediaKind,
    previewKind: isTextPost ? 'text' : undefined,
    previewText,
    previewState: getProfilePreviewState({
      mediaKind: item.mediaKind,
      mediaUrl: item.mediaUrl,
      previewKind: isTextPost ? 'text' : undefined,
      previewText,
      previewUrl,
    }),
    previewStatusLabel: item.mediaKind === 'video' && !previewUrl ? 'Preview unavailable' : undefined,
    isGridReady: isTextPost
      ? Boolean(previewText?.trim())
      : descriptor?.gridReady ?? primaryMedia?.gridReady ?? Boolean(previewUrl),
    isArchived: false,
    avatarUrl: item.creator.avatar,
    avatarLabel: item.creator.name || item.creator.username || 'Creator',
    countLabel: formatCompactCount(item.saveCount),
    viewerSource: 'profile-saved',
    sourceId: item.id,
    artVariant: item.creationMode === 'motion' ? 'runner' : item.category === 'video' ? 'city' : 'tree',
    href: `/showcase/${item.id}`,
  };
}

export function savedShowcaseToProfileMediaCards(items: ShowcaseFeedItem[] | null | undefined) {
  return (items ?? [])
    .filter((item) => item.isSaved)
    .map(showcaseToSavedProfileMediaCard)
    .filter((card) => card.isGridReady);
}

function ownerPostBadge(item: OwnerPostListItem) {
  if (item.bundle?.accessMode === 'free') return 'Free unlock';
  if (item.bundle?.accessMode === 'paid') return formatUsdCents(item.bundle.priceUsdCents);
  if (item.category === 'text' || item.postFormat === 'text') return 'Prompt';
  if (item.mediaKind === 'video' || item.category === 'video') return 'Video';
  return 'Post';
}

function generationStatusLabel(status: string | null | undefined) {
  if (status === 'succeeded') return 'Ready';
  if (status === 'processing') return 'Rendering';
  if (status === 'waiting') return 'Queued';
  if (status === 'failed') return 'Failed';
  return status ? capitalize(status) : 'Draft';
}

function getProfilePreviewState({
  mediaKind,
  mediaUrl,
  previewKind,
  previewText,
  previewUrl,
}: {
  mediaKind: 'image' | 'video' | null;
  mediaUrl: string | null;
  previewKind?: 'text';
  previewText?: string;
  previewUrl?: string | null;
}): ProfilePreviewState {
  if (previewKind === 'text' && previewText?.trim()) return 'text';
  if (mediaKind === 'video') return previewUrl ? 'videoPoster' : mediaUrl ? 'videoFallback' : 'artFallback';
  if (mediaKind === 'image' && (previewUrl || mediaUrl)) return 'image';
  return 'artFallback';
}

function postVisibilityLabel(visibility: string | null | undefined) {
  if (!visibility) return 'Private';
  return capitalize(visibility);
}

function capitalize(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return value;
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function getEmailLocalPart(email?: string | null) {
  const localPart = email?.split('@')[0]?.trim();
  return localPart || null;
}

/**
 * First character to show when a creator has no avatar image.
 *
 * Callers pass whatever label they have — sometimes a display name, often a
 * handle. A handle leads with `@`, so taking `name[0]` blindly badges every
 * avatar-less creator with the same "@" instead of their own initial.
 *
 * Only *leading* punctuation is stripped, and any letter is kept whatever the
 * script, so non-Latin names still get their own initial rather than a
 * placeholder.
 */
export function getAvatarInitial(name: string) {
  const cleaned = name.trim().replace(/^[@#~!?.,:;'"`^*_+=\-\/\\|()[\]{}<>\s]+/, '');
  return cleaned[0]?.toUpperCase() || 'C';
}
