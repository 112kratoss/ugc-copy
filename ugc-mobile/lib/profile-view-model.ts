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

export type ProfileMediaSwipeDirection = 'left' | 'right';

export const PROFILE_MEDIA_TABS: ProfileMediaTab[] = ['Saved', 'Creations', 'Posts'];

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

export function getProfileStats({
  generationsCount,
  postsCount,
  savedCount,
}: {
  generationsCount: number;
  postsCount: number;
  savedCount: number;
}): ProfileStat[] {
  return [
    { label: 'Creations', value: formatCompactCount(generationsCount) },
    { label: 'Posts', value: formatCompactCount(postsCount) },
    { label: 'Saved', value: formatCompactCount(savedCount) },
  ];
}

export function getProfileMediaSectionTitle(tab: ProfileMediaTab) {
  if (tab === 'Saved') return 'Saved Media';
  return tab;
}

export function getProfileMediaEmptyTitle(tab: ProfileMediaTab) {
  if (tab === 'Saved') return 'No saved media yet';
  if (tab === 'Creations') return 'No creations yet';
  return 'No posts yet';
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
    isGridReady: !item.archivedAt && (isTextPost
      ? Boolean(previewText.trim())
      : descriptor?.gridReady ?? primaryMedia?.gridReady ?? Boolean(previewUrl)),
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
