'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Ban,
  ChevronRight,
  Crown,
  ExternalLink,
  FileText,
  Gift,
  Heart,
  ImageIcon,
  Layers3,
  Loader2,
  PencilLine,
  Store,
  UserRound,
  WalletCards,
} from 'lucide-react';
import UnavailableMediaNote from '@/components/UnavailableMediaNote';

import { useAuth } from '@/components/AuthProvider';
import { HoverVideo } from '@/components/HoverVideo';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import ProfileShareButton from '@/components/ProfileShareButton';
import TextPostPreviewCard from '@/components/TextPostPreviewCard';
import { useOptimisticPostSave } from '@/components/useOptimisticPostSave';
import { loadShowcaseReelViewer } from '@/app/showcase/showcase-reel-loader';
import {
  blockCreatorAfterConfirmation,
  reportCreatorAfterConfirmation,
  reportPostAfterConfirmation,
  toastSafetyOutcome,
} from '@/lib/feed-safety-actions';
import { resolvePlaybackUrl } from '@/lib/media-descriptor';
import { getBundleAccessLabel, type PostResourceKind } from '@/lib/post-resource-bundles';
import type { OwnerProfileStats } from '@/lib/profile';
import {
  pushReelEntry,
  readCurrentReelHistoryMode,
  readReelHistoryMode,
  replaceReelEntry,
  type ReelHistoryMode,
} from '@/lib/reel-history-entry';
import { buildShowcaseDetailPath } from '@/lib/share';
import { requestShowcaseRemix } from '@/lib/showcase-remix-client';
import type {
  ShowcaseCreator,
  ShowcaseFeedItem,
  ShowcaseMediaItem,
} from '@/lib/showcase';
import MatureContentSetting from './MatureContentSetting';

// Posts and Saved. The creations library is Studio's (/creations): the
// profile used to draw it again as a third tab.
type ProfileMediaTab = 'posts' | 'saved';

interface OwnerPost {
  id: string;
  generationId: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  archivedAt: string | null;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  mediaItems?: ShowcaseMediaItem[];
  title: string;
  description: string;
  prompt: string;
  body: string;
  category: string;
  postFormat: 'text' | 'media' | 'mixed';
  sourceKind: 'magicbooklet' | 'external' | 'manual';
  sourceTool: string | null;
  sourceToolSlug?: string | null;
  createdAt: string;
  updatedAt: string;
  publicPath: string | null;
  ownerPath: string;
  resourcePath: string | null;
  canShare: boolean;
  commentCount?: number;
  bundle: {
    id: string;
    accessMode: 'free' | 'paid';
    status: 'draft' | 'published';
    priceUsdCents: number;
    resourceKinds: PostResourceKind[];
  } | null;
}

interface OffsetPageInfo {
  hasMore: boolean;
  nextOffset: number | null;
}

/** The payout balance the Wallet card shows: what the seller can withdraw now. */
export interface OwnerWalletBalance {
  availableUsd: string;
}

interface OwnerProfileMediaHubProps {
  creator: ShowcaseCreator;
  profile?: {
    bio: string;
    coverUrl: string | null;
    credits: number | null;
  };
  /**
   * The server's library totals (`owner_profile_counts`), as the app's header
   * draws them; null when the count could not be read, which draws "—".
   */
  stats?: OwnerProfileStats | null;
  /**
   * The payout state's available balance, as `GET /api/creator/payouts` reads
   * it; null when it could not be read, which draws "Balance unavailable".
   */
  walletBalance?: OwnerWalletBalance | null;
  publicProfilePath?: string | null;
  publicProfileDisplayName?: string;
}

const PAGE_SIZE = 24;
const EMPTY_SHOWCASE_ITEMS: ShowcaseFeedItem[] = [];

function ReelLoadingFallback() {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 text-sm font-bold text-white backdrop-blur-sm">
      <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-950 px-5 py-3">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Opening Explore
      </span>
    </div>
  );
}

const ShowcaseReelViewer = dynamic(
  () => loadShowcaseReelViewer(),
  { ssr: false, loading: ReelLoadingFallback }
);

function isProfileMediaTab(value: string | null): value is ProfileMediaTab {
  return value === 'posts' || value === 'saved';
}

function appendUnique<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

function mapOwnerPostToFeedItem(post: OwnerPost, creator: ShowcaseCreator): ShowcaseFeedItem {
  const resourceKinds = post.bundle?.resourceKinds ?? [];
  const category = post.postFormat === 'text'
    ? 'text'
    : post.mediaKind === 'video'
      ? 'video'
      : 'image';

  return {
    id: post.id,
    generationId: post.generationId,
    mediaUrl: post.mediaUrl,
    mediaKind: post.mediaKind,
    mediaItems: post.mediaItems,
    model: post.sourceTool || post.sourceKind,
    title: post.title,
    prompt: post.prompt,
    body: post.body || post.description,
    category,
    postFormat: post.postFormat,
    saveCount: 0,
    remixCount: 0,
    commentCount: post.commentCount ?? 0,
    // The reel takes comments on public posts only, as the server does.
    visibility: post.visibility === 'unlisted' ? 'unlisted' : 'public',
    createdAt: post.createdAt,
    creator,
    sourceKind: post.sourceKind,
    sourceTool: post.sourceTool,
    sourceToolSlug: post.sourceToolSlug,
    asset: post.bundle ? {
      id: post.bundle.id,
      postId: post.id,
      title: `${post.title} recipe`,
      accessMode: post.bundle.accessMode,
      priceUsdCents: post.bundle.priceUsdCents,
      previewText: 'Reusable recipe attached to this post.',
      allowRemix: resourceKinds.includes('remix'),
      resourceKinds,
    } : null,
    canRemix: Boolean(post.generationId) || resourceKinds.includes('remix'),
  };
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function MediaCard({
  title,
  subtitle,
  mediaUrl,
  previewUrl,
  renditionUrl,
  mediaKind,
  textBody,
  badges,
  onClick,
  href,
  actionLabel,
  unavailable = false,
}: {
  title: string;
  subtitle: string;
  mediaUrl: string | null;
  /** The media's only source is gone: draw the explicit note, never the address. */
  unavailable?: boolean;
  previewUrl?: string | null;
  renditionUrl?: string | null;
  mediaKind: 'image' | 'video' | null;
  textBody?: string;
  badges?: string[];
  onClick?: () => void;
  href?: string;
  actionLabel?: string;
}) {
  const isTextCard = Boolean(textBody && !mediaUrl);
  const isInteractive = Boolean(href || onClick);
  const content = (
    <>
      <div className="relative aspect-[4/5] overflow-hidden bg-zinc-950">
        {unavailable ? (
          <UnavailableMediaNote className="h-full w-full" />
        ) : mediaKind === 'video' && mediaUrl ? (
          <HoverVideo
            src={resolvePlaybackUrl({ url: mediaUrl, renditionUrl })}
            poster={previewUrl}
            className="absolute inset-0 h-full w-full object-cover opacity-90 transition duration-300 group-hover:scale-[1.015] group-hover:opacity-100"
          />
        ) : mediaKind === 'image' && mediaUrl ? (
          <OptimizedPreviewImage
            previewSrc={previewUrl || mediaUrl}
            fallbackSrc={mediaUrl}
            alt={title}
            sizes="(min-width: 1280px) 22vw, (min-width: 768px) 33vw, 50vw"
            className="object-cover opacity-90 transition duration-300 group-hover:scale-[1.015] group-hover:opacity-100"
          />
        ) : textBody ? (
          <TextPostPreviewCard
            title={title}
            summary={textBody}
            className="h-full rounded-none border-0 shadow-none"
            showStats={false}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-zinc-600">
            <ImageIcon className="h-9 w-9" />
          </div>
        )}

        {badges?.length ? (
          <div className="absolute left-3 top-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1.5">
            {badges.map((badge) => (
              <span key={badge} className="rounded-full border border-white/12 bg-black/60 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-100 backdrop-blur-md">
                {badge}
              </span>
            ))}
          </div>
        ) : null}

        <div className={`absolute inset-x-0 bottom-0 p-4 ${isTextCard ? 'bg-black/70 pt-3 backdrop-blur-sm' : 'bg-gradient-to-t from-black via-black/75 to-transparent pt-16'}`}>
          {!isTextCard ? <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-white">{title}</h3> : null}
          <div className={`${isTextCard ? '' : 'mt-1'} flex items-center justify-between gap-3`}>
            <p className="min-w-0 truncate text-xs text-zinc-400">{subtitle}</p>
            {/* A card with nothing to open gets no verb. */}
            {isInteractive ? (
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                {actionLabel || (href ? 'Edit' : 'View')}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );

  const className = `group block w-full overflow-hidden rounded-[22px] border border-white/8 bg-[#111215] text-left shadow-[0_18px_50px_rgba(0,0,0,0.22)] transition${
    isInteractive ? ' hover:-translate-y-0.5 hover:border-white/16' : ''
  }`;

  if (href) {
    return <Link href={href} className={className}>{content}</Link>;
  }

  // Not a button: a focusable control that does nothing is worse than plain
  // content.
  if (!onClick) {
    return <div className={className}>{content}</div>;
  }

  return <button type="button" onClick={onClick} className={className} aria-label={`Open ${title}`}>{content}</button>;
}

export default function OwnerProfileMediaHub({
  creator,
  profile = { bio: '', coverUrl: null, credits: null },
  stats = null,
  walletBalance = null,
  publicProfilePath = null,
  publicProfileDisplayName = '',
}: OwnerProfileMediaHubProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { session, user } = useAuth();
  const accessToken = session?.access_token ?? null;
  const userId = user?.id ?? null;
  const initialTab = isProfileMediaTab(searchParams.get('tab')) ? searchParams.get('tab') as ProfileMediaTab : 'posts';
  const [activeTab, setActiveTab] = useState<ProfileMediaTab>(initialTab);
  const [ownerPosts, setOwnerPosts] = useState<OwnerPost[]>([]);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(() => searchParams.get('post'));
  const [selectedMediaIndex, setSelectedMediaIndex] = useState(() => {
    const value = Number(searchParams.get('media'));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  });
  const [loadingTabs, setLoadingTabs] = useState<Set<ProfileMediaTab>>(() => new Set([initialTab]));
  const [loadingMoreTab, setLoadingMoreTab] = useState<ProfileMediaTab | null>(null);
  const [postsPageInfo, setPostsPageInfo] = useState<OffsetPageInfo>({ hasMore: false, nextOffset: null });
  const [savedPageInfo, setSavedPageInfo] = useState<OffsetPageInfo>({ hasMore: false, nextOffset: null });
  const [errors, setErrors] = useState<Partial<Record<ProfileMediaTab, string>>>({});
  // The libraries are the account's, not the token's: a refreshed token (about
  // hourly, and on coming back to a long-idle tab) keeps every page loaded and
  // the open reel. The requests read the newest token through `authHeaders`.
  const loadedUserRef = useRef<string | null>(null);
  // How the reel's close leaves history: read from the entry when the hub
  // mounts and on popstate, and set by a tile.
  const reelHistoryModeRef = useRef<ReelHistoryMode>(null);
  // The server's Saved total moves with what is done here, as the app's header
  // does, until the next server render brings a fresh one. Kept against the
  // totals it applies to, so a fresh set starts again from the server's number.
  const [savedAdjustment, setSavedAdjustment] = useState(() => ({ base: stats, delta: 0 }));
  const savedTotal = stats
    ? Math.max(0, stats.saved + (savedAdjustment.base === stats ? savedAdjustment.delta : 0))
    : null;
  const adjustSavedTotal = (change: number) => {
    setSavedAdjustment((current) => ({
      base: stats,
      delta: (current.base === stats ? current.delta : 0) + change,
    }));
  };

  const authRequired = useCallback(() => {
    router.push(`/login?returnUrl=${encodeURIComponent('/profile')}`);
  }, [router]);

  const postSaveState = useOptimisticPostSave<ShowcaseFeedItem>({
    initialItems: EMPTY_SHOWCASE_ITEMS,
    accessToken,
    isSignedIn: Boolean(user && accessToken),
    onAuthRequired: authRequired,
    onError: (error) => console.error('Profile post save failed:', error),
    onSuccess: ({ isSaved }) => adjustSavedTotal(isSaved ? 1 : -1),
    sourceSurface: 'creator-profile',
  });
  const savedSaveState = useOptimisticPostSave<ShowcaseFeedItem>({
    initialItems: EMPTY_SHOWCASE_ITEMS,
    accessToken,
    isSignedIn: Boolean(user && accessToken),
    onAuthRequired: authRequired,
    onError: (error) => console.error('Profile saved-media update failed:', error),
    onSuccess: ({ isSaved }) => adjustSavedTotal(isSaved ? 1 : -1),
    sourceSurface: 'creator-profile',
  });
  const setProfilePostItems = postSaveState.setItems;
  const setProfileSavedItems = savedSaveState.setItems;
  const setProfileSavedItemIds = savedSaveState.setSavedItemIds;
  // What is on screen now, for an answer that arrives after a question and a
  // request: the saved list can have grown and the reel moved on since.
  const savedItemsRef = useRef<ShowcaseFeedItem[]>(EMPTY_SHOWCASE_ITEMS);
  const savedItemIdsRef = useRef<Set<string>>(savedSaveState.savedItemIds);
  const selectedPostIdRef = useRef<string | null>(selectedPostId);
  useEffect(() => {
    savedItemsRef.current = savedSaveState.items;
    savedItemIdsRef.current = savedSaveState.savedItemIds;
    selectedPostIdRef.current = selectedPostId;
  }, [savedSaveState.items, savedSaveState.savedItemIds, selectedPostId]);

  const authHeaders = useMemo(() => accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined, [accessToken]);

  const loadPosts = useCallback(async (offset = 0, append = false) => {
    const response = await fetch(`/api/posts?scope=owner&includeArchived=false&limit=${PAGE_SIZE}&offset=${offset}`, { headers: authHeaders });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'Could not load your posts.');
    const posts = Array.isArray(payload.posts) ? payload.posts as OwnerPost[] : [];
    setOwnerPosts((current) => append ? appendUnique(current, posts) : posts);
    const feedItems = posts.map((post) => mapOwnerPostToFeedItem(post, creator));
    setProfilePostItems((current) => append ? appendUnique(current, feedItems) : feedItems);
    setPostsPageInfo({
      hasMore: Boolean(payload.pageInfo?.hasMore),
      nextOffset: typeof payload.pageInfo?.nextOffset === 'number' ? payload.pageInfo.nextOffset : null,
    });
  }, [authHeaders, creator, setProfilePostItems]);

  const loadSaved = useCallback(async (offset = 0, append = false) => {
    const response = await fetch(`/api/showcase/saved-media?limit=${PAGE_SIZE}&offset=${offset}`, { headers: authHeaders });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || 'Could not load saved posts.');
    const items = Array.isArray(payload.items) ? payload.items as ShowcaseFeedItem[] : [];
    setProfileSavedItems((current) => append ? appendUnique(current, items) : items);
    setProfileSavedItemIds((current) => {
      const next = append ? new Set(current) : new Set<string>();
      items.forEach((item) => next.add(item.id));
      return next;
    });
    setSavedPageInfo({
      hasMore: Boolean(payload.pageInfo?.hasMore),
      nextOffset: typeof payload.pageInfo?.nextOffset === 'number' ? payload.pageInfo.nextOffset : null,
    });
  }, [authHeaders, setProfileSavedItemIds, setProfileSavedItems]);

  const runTabLoad = useCallback(async (tab: ProfileMediaTab) => {
    setLoadingTabs((current) => new Set(current).add(tab));
    setErrors((current) => ({ ...current, [tab]: undefined }));

    try {
      if (tab === 'posts') await loadPosts();
      if (tab === 'saved') await loadSaved();
    } catch (error) {
      const fallback = tab === 'posts' ? 'Could not load your posts.' : 'Could not load saved posts.';
      setErrors((current) => ({
        ...current,
        [tab]: error instanceof Error ? error.message : fallback,
      }));
    } finally {
      setLoadingTabs((current) => {
        const next = new Set(current);
        next.delete(tab);
        return next;
      });
    }
  }, [loadPosts, loadSaved]);

  useEffect(() => {
    if (!userId || !accessToken || loadedUserRef.current === userId) return;
    loadedUserRef.current = userId;
    setLoadingTabs(new Set<ProfileMediaTab>([initialTab]));
    setErrors({});

    void (async () => {
      await runTabLoad(initialTab);
      await runTabLoad(initialTab === 'posts' ? 'saved' : 'posts');
    })();
  }, [accessToken, initialTab, runTabLoad, userId]);

  const updateLocation = useCallback((updates: {
    tab?: ProfileMediaTab;
    postId?: string | null;
    mediaIndex?: number;
  }, mode: 'push' | 'replace') => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', updates.tab ?? activeTab);
    if (updates.postId) {
      params.set('post', updates.postId);
      if ((updates.mediaIndex ?? 0) > 0) params.set('media', String(updates.mediaIndex));
      else params.delete('media');
    } else if (updates.postId === null) {
      params.delete('post');
      params.delete('media');
    }
    const nextUrl = `${pathname}?${params.toString()}${window.location.hash}`;
    // An entry pushed for a post's reel says so on its state
    // (`reel-history-entry.ts`), and keeps saying so while the reel moves to
    // another post or slide; a tab's entry is a plain one.
    if (mode === 'push') pushReelEntry(updates.postId ? 'post' : null, nextUrl);
    else replaceReelEntry(nextUrl);
  }, [activeTab, pathname]);

  useEffect(() => {
    // The entry the hub mounts on says how its reel was opened: one a tile
    // pushed (a reload, or a Back from a page it linked to, brought the reader
    // back to it) closes by going Back to the entry under it; one any other
    // entry names opened by address, and its close replaces the entry.
    reelHistoryModeRef.current = readCurrentReelHistoryMode('post');
    const handlePopState = (event: PopStateEvent) => {
      const params = new URLSearchParams(window.location.search);
      const tab = isProfileMediaTab(params.get('tab')) ? params.get('tab') as ProfileMediaTab : 'posts';
      const mediaIndex = Number(params.get('media'));
      setActiveTab(tab);
      setSelectedPostId(params.get('post'));
      setSelectedMediaIndex(Number.isInteger(mediaIndex) && mediaIndex >= 0 ? mediaIndex : 0);
      // The same for the entry Back or Forward reaches.
      reelHistoryModeRef.current = readReelHistoryMode('post', params, event.state);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const selectTab = (tab: ProfileMediaTab) => {
    setActiveTab(tab);
    setSelectedPostId(null);
    updateLocation({ tab, postId: null }, 'push');
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: ProfileMediaTab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabOrder: ProfileMediaTab[] = ['posts', 'saved'];
    const currentIndex = tabOrder.indexOf(tab);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabOrder.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabOrder.length) % tabOrder.length;
    const nextTab = tabOrder[nextIndex];
    selectTab(nextTab);
    document.getElementById(`profile-tab-${nextTab}`)?.focus();
  };

  const openPost = (item: ShowcaseFeedItem) => {
    reelHistoryModeRef.current = 'pushed';
    setSelectedMediaIndex(0);
    setSelectedPostId(item.id);
    updateLocation({ postId: item.id, mediaIndex: 0 }, 'push');
  };

  const selectPost = (id: string) => {
    setSelectedPostId(id);
    setSelectedMediaIndex(0);
    updateLocation({ postId: id, mediaIndex: 0 }, 'replace');
  };

  // A thread read in the reel reports the post's comment count; the lists'
  // copies follow it, so the reel opened on that post again says the same.
  const updateCommentCount = useCallback((postId: string, commentCount: number) => {
    const withCount = (current: ShowcaseFeedItem[]) => {
      const index = current.findIndex((candidate) => candidate.id === postId);
      if (index < 0 || current[index].commentCount === commentCount) return current;
      const next = current.slice();
      next[index] = { ...current[index], commentCount };
      return next;
    };
    setProfilePostItems(withCount);
    setProfileSavedItems(withCount);
  }, [setProfilePostItems, setProfileSavedItems]);

  const closePost = () => {
    setSelectedPostId(null);
    if (reelHistoryModeRef.current === 'pushed') {
      reelHistoryModeRef.current = null;
      window.history.back();
    } else {
      reelHistoryModeRef.current = null;
      updateLocation({ postId: null }, 'replace');
    }
  };

  // The reel's ⋯ over saved posts, which are other people's: Report content,
  // Report user and Block user, asked for and sent as a feed card's are
  // (`lib/feed-safety-actions.ts`). No Not interested or Hide: a saved list is
  // not a feed to tune. The Posts tab's reel has no ⋯: every post there is the
  // viewer's own.
  const handleSavedReportContent = async (reportedItem: ShowcaseFeedItem) => {
    if (!accessToken) return authRequired();
    // The post stays saved: reporting it is not unsaving it.
    toastSafetyOutcome(await reportPostAfterConfirmation({
      postId: reportedItem.id,
      accessToken,
      surface: 'saved',
    }));
  };
  const handleSavedReportUser = async (reportedItem: ShowcaseFeedItem) => {
    const creatorId = reportedItem.creator.id;
    if (!creatorId || creatorId === user?.id) return;
    if (!accessToken) return authRequired();
    toastSafetyOutcome(await reportCreatorAfterConfirmation({
      userId: creatorId,
      accessToken,
      surface: 'saved',
    }));
  };
  const handleSavedBlockUser = async (blockedItem: ShowcaseFeedItem) => {
    const creatorId = blockedItem.creator.id;
    if (!creatorId || creatorId === user?.id) return;
    if (!accessToken) return authRequired();
    const outcome = await blockCreatorAfterConfirmation({
      userId: creatorId,
      creatorName: blockedItem.creator.name,
      accessToken,
    });
    toastSafetyOutcome(outcome);
    if (outcome.status !== 'done') return;
    // The server's saved list leaves out a blocked creator's posts
    // (`showcase-saved-media-service.ts`); the page does the same at once. A
    // reel open on one of them moves to the post that followed it, or the one
    // before, or closes.
    const isBlocked = (candidate: ShowcaseFeedItem) => candidate.creator.id === creatorId;
    const currentItems = savedItemsRef.current;
    const openId = selectedPostIdRef.current;
    const openPosition = openId ? currentItems.findIndex((candidate) => candidate.id === openId) : -1;
    // The Saved total drops by the posts of theirs still saved here; any on a
    // page not loaded yet come off with the next server render.
    const blockedSavedCount = currentItems
      .filter((candidate) => isBlocked(candidate) && savedItemIdsRef.current.has(candidate.id))
      .length;
    if (blockedSavedCount > 0) adjustSavedTotal(-blockedSavedCount);
    setProfileSavedItems((latestItems) => latestItems.filter((candidate) => !isBlocked(candidate)));
    if (openPosition < 0 || !isBlocked(currentItems[openPosition])) return;
    const replacementItem = currentItems.slice(openPosition + 1).find((candidate) => !isBlocked(candidate))
      ?? currentItems.slice(0, openPosition).reverse().find((candidate) => !isBlocked(candidate))
      ?? null;
    if (replacementItem) {
      selectPost(replacementItem.id);
    } else {
      closePost();
    }
  };

  const publicPostItems = useMemo(
    () => postSaveState.items.filter((item) => ownerPosts.some((post) => post.id === item.id && post.canShare)),
    [ownerPosts, postSaveState.items]
  );
  const viewerItems = activeTab === 'saved' ? savedSaveState.items : publicPostItems;
  const activeSaveState = activeTab === 'saved' ? savedSaveState : postSaveState;
  const activePageInfo = activeTab === 'saved' ? savedPageInfo : postsPageInfo;
  const tabs = [
    { id: 'posts' as const, label: 'Posts', count: stats?.posts ?? null, icon: Layers3 },
    { id: 'saved' as const, label: 'Saved', count: savedTotal, icon: Heart },
  ];

  const loadMore = async () => {
    setLoadingMoreTab(activeTab);
    setErrors((current) => ({ ...current, [activeTab]: undefined }));
    try {
      if (activeTab === 'posts' && postsPageInfo.nextOffset !== null) await loadPosts(postsPageInfo.nextOffset, true);
      if (activeTab === 'saved' && savedPageInfo.nextOffset !== null) await loadSaved(savedPageInfo.nextOffset, true);
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [activeTab]: error instanceof Error ? error.message : `Could not load more ${activeTab}.`,
      }));
    } finally {
      setLoadingMoreTab(null);
    }
  };

  const emptyCopy: Record<ProfileMediaTab, { title: string; body: string; href: string; cta: string }> = {
    posts: {
      title: 'Your published story starts here',
      body: 'Turn a finished creation into a post, add context, then attach an optional recipe.',
      href: '/post/new?from=profile&returnTo=%2Fprofile%3Ftab%3Dposts',
      cta: 'Post',
    },
    saved: {
      title: 'Nothing saved yet',
      body: 'Save useful posts from Explore and they will stay collected here.',
      href: '/showcase',
      cta: 'Go to Explore',
    },
  };

  const activeCount = activeTab === 'posts' ? ownerPosts.length : savedSaveState.items.length;
  const hasMore = activePageInfo.hasMore;
  const isLoading = loadingTabs.has(activeTab);

  return (
    <>
      <section className="ui-enter mb-5 overflow-hidden rounded-[30px] border border-white/10 bg-[var(--ui-surface-1)] shadow-[0_28px_90px_rgba(0,0,0,0.28)]">
        <div className="relative h-36 overflow-hidden bg-[radial-gradient(circle_at_20%_0%,rgba(255,122,89,0.28),transparent_42%),radial-gradient(circle_at_85%_20%,rgba(56,189,248,0.18),transparent_36%),#151519] sm:h-52">
          {profile.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.coverUrl} alt="" className="h-full w-full object-cover" />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-[#151518] via-black/5 to-black/10" />
        </div>

        <div className="relative px-5 pb-6 sm:px-7 sm:pb-7">
          <div className="-mt-11 flex flex-col gap-5 sm:-mt-12 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex min-w-0 items-end gap-4">
              <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-[#151518] bg-zinc-900 shadow-xl sm:h-28 sm:w-28">
                {creator.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={creator.avatar} alt={`${creator.name} avatar`} className="h-full w-full object-cover" />
                ) : (
                  <UserRound className="h-10 w-10 text-zinc-500" aria-hidden />
                )}
              </div>
              <div className="min-w-0 pb-1">
                <h2 className="truncate text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{creator.name}</h2>
                {creator.username ? <p className="mt-1 text-sm font-bold text-[var(--ui-primary)]">@{creator.username}</p> : null}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 sm:justify-end">
              {publicProfilePath ? (
                <Link href={publicProfilePath} className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm font-bold text-zinc-100 transition hover:bg-white/10">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  View public
                </Link>
              ) : null}
              {creator.username ? (
                <ProfileShareButton
                  username={creator.username}
                  displayName={publicProfileDisplayName || creator.name}
                  sourceSurface="profile"
                  accessToken={accessToken}
                  label="Share"
                  className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm font-bold text-zinc-100 transition hover:bg-white/10 disabled:opacity-60"
                />
              ) : null}
              <Link href="/profile/edit" className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]">
                <PencilLine className="h-4 w-4" aria-hidden />
                Edit profile
              </Link>
            </div>
          </div>

          <p className="mt-5 max-w-2xl text-sm leading-6 text-zinc-300">
            {profile.bio.trim() || 'Add a short bio so people understand what you create.'}
          </p>

          <dl className="mt-6 grid grid-cols-3 border-t border-white/8 pt-5">
            {[
              { label: 'Creations', value: stats?.creations ?? '—' },
              { label: 'Posts', value: stats?.posts ?? '—' },
              { label: 'Saved', value: savedTotal ?? '—' },
            ].map((stat, index) => (
              <div key={stat.label} className={`text-center ${index > 0 ? 'border-l border-white/8' : ''}`}>
                <dd className="text-lg font-extrabold text-white sm:text-xl">{stat.value}</dd>
                <dt className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500 sm:text-xs">{stat.label}</dt>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-label="Creator account shortcuts" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Link href="/pricing" className="ui-focus-ring group flex min-h-28 items-center gap-3 rounded-[24px] border border-white/8 bg-[var(--ui-surface-1)] p-4 transition hover:-translate-y-0.5 hover:border-amber-300/20 hover:bg-[var(--ui-surface-2)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-300"><Crown className="h-5 w-5" aria-hidden /></span>
          <span className="min-w-0"><span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Credits</span><span className="mt-1 block truncate text-lg font-extrabold text-white">{profile.credits ?? '—'}</span></span>
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" aria-hidden />
        </Link>
        <Link href="/marketplace/sell" className="ui-focus-ring group flex min-h-28 items-center gap-3 rounded-[24px] border border-white/8 bg-[var(--ui-surface-1)] p-4 transition hover:-translate-y-0.5 hover:border-[rgba(255,122,89,0.24)] hover:bg-[var(--ui-surface-2)]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]"><WalletCards className="h-5 w-5" aria-hidden /></span>
          {/* Lifetime earnings here read as money in hand, and stayed whole after a payout request took the balance to $0.00. */}
          <span className="min-w-0"><span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Wallet</span><span className="mt-1 block truncate text-lg font-extrabold text-white">{walletBalance ? walletBalance.availableUsd : '—'}</span><span className="mt-0.5 block truncate text-xs text-zinc-500">{walletBalance ? 'Available to withdraw' : 'Balance unavailable'}</span></span>
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" aria-hidden />
        </Link>
        <Link href="/invite" className="ui-focus-ring group col-span-2 flex min-h-24 items-center gap-3 rounded-[24px] border border-amber-300/15 bg-[linear-gradient(135deg,rgba(245,158,11,0.08),rgba(24,24,27,0.86))] p-4 transition hover:-translate-y-0.5 hover:border-amber-300/25 lg:col-span-1">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-300"><Gift className="h-5 w-5" aria-hidden /></span>
          <span className="min-w-0"><span className="block font-bold text-white">Invite &amp; Earn</span><span className="mt-1 block truncate text-xs text-zinc-500">Earn bonus credits</span></span>
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" aria-hidden />
        </Link>
        <Link href="/marketplace/sell" className="ui-focus-ring group col-span-2 flex min-h-24 items-center gap-3 rounded-[24px] border border-white/8 bg-[var(--ui-surface-1)] p-4 transition hover:-translate-y-0.5 hover:border-[rgba(255,122,89,0.24)] hover:bg-[var(--ui-surface-2)] lg:col-span-1">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--ui-primary-soft)] text-[var(--ui-primary)]"><Store className="h-5 w-5" aria-hidden /></span>
          <span className="min-w-0"><span className="block font-bold text-white">Recipe sales</span><span className="mt-1 block truncate text-xs text-zinc-500">Your recipes and earnings</span></span>
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" aria-hidden />
        </Link>
        {/* The one way to see whom you blocked and take a block back: a blocked creator is left out of every place that would show them. Quiet, and a row of its own: it is housekeeping, not a destination. */}
        <Link href="/profile/blocked" className="ui-focus-ring group col-span-2 flex min-h-14 items-center gap-3 rounded-[20px] border border-white/8 bg-[var(--ui-surface-1)] px-4 py-3 transition hover:border-white/15 hover:bg-[var(--ui-surface-2)] lg:col-span-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-zinc-300"><Ban className="h-4 w-4" aria-hidden /></span>
          <span className="min-w-0"><span className="block text-sm font-bold text-white">Blocked users</span><span className="mt-0.5 block truncate text-xs text-zinc-500">See whom you blocked, and unblock them</span></span>
          <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" aria-hidden />
        </Link>
        <MatureContentSetting />
      </section>

      <section id="profile-media" className="mb-8 overflow-hidden rounded-[30px] border border-white/8 bg-[linear-gradient(145deg,rgba(24,24,27,0.78),rgba(8,8,10,0.94))] shadow-[0_28px_90px_rgba(0,0,0,0.3)]">
      <div className="border-b border-white/8 px-5 py-6 sm:px-7">
        {/* A new post starts from the top bar's Create menu, and creations
            live in Studio. */}
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--ui-primary)]">Your media</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Your posts and saves</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            Explore viewers see your posts in the reel. Your creations stay private in{' '}
            <Link href="/creations" className="ui-focus-ring rounded font-semibold text-zinc-200 underline-offset-4 hover:underline">Studio</Link>
            {' '}until you post them.
          </p>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2 rounded-[22px] border border-white/8 bg-black/25 p-1" role="tablist" aria-label="Profile media">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`profile-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`profile-panel-${tab.id}`}
                aria-label={tab.count === null ? tab.label : `${tab.label} ${tab.count}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                className={`ui-focus-ring inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-[18px] px-2 text-xs font-semibold transition sm:gap-2 sm:px-4 sm:text-sm ${selected
                  ? 'bg-[var(--ui-primary)] text-[var(--ui-primary-on)] shadow-[0_8px_24px_rgba(255,122,89,0.18)]'
                  : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white'}`}
              >
                <Icon className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden />
                <span className="truncate">{tab.label}</span>
                <span className={`hidden rounded-full px-2 py-0.5 text-xs sm:inline ${selected ? 'bg-black/20' : 'bg-black/25 text-zinc-500'}`}>{tab.count ?? '—'}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div id={`profile-panel-${activeTab}`} role="tabpanel" aria-labelledby={`profile-tab-${activeTab}`} className="p-4 sm:p-6">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label="Loading profile media">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="aspect-[4/5] animate-pulse rounded-[22px] border border-white/8 bg-white/[0.04]" />
            ))}
          </div>
        ) : errors[activeTab] && activeCount === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-rose-300/15 bg-rose-500/10 text-rose-200"><FileText className="h-6 w-6" aria-hidden /></div>
            <h3 className="mt-5 text-xl font-semibold text-white">This section did not load</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">{errors[activeTab]}</p>
            <button type="button" onClick={() => void runTabLoad(activeTab)} className="ui-focus-ring mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black transition hover:bg-zinc-200">
              Retry
            </button>
          </div>
        ) : activeCount === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-400">
              {activeTab === 'saved' ? <Heart className="h-6 w-6" /> : <FileText className="h-6 w-6" />}
            </div>
            <h3 className="mt-5 text-xl font-semibold text-white">{emptyCopy[activeTab].title}</h3>
            <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
              {errors[activeTab] || emptyCopy[activeTab].body}
            </p>
            <Link href={emptyCopy[activeTab].href} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-bold text-black transition hover:bg-zinc-200">
              {emptyCopy[activeTab].cta}
              <ExternalLink className="h-4 w-4" />
            </Link>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {activeTab === 'posts' ? ownerPosts.map((post) => {
                const feedItem = postSaveState.items.find((item) => item.id === post.id);
                const recipeLabel = post.bundle
                  ? post.bundle.accessMode === 'free'
                    ? 'Free recipe'
                    : getBundleAccessLabel('paid', post.bundle.priceUsdCents).replace(/\s+unlock$/i, ' recipe')
                  : null;
                return (
                  <MediaCard
                    key={post.id}
                    title={post.title}
                    subtitle={`${post.visibility} · ${formatShortDate(post.updatedAt)}`}
                    mediaUrl={post.mediaUrl}
                    unavailable={Boolean(post.mediaItems?.[0]?.sourceUnavailableAt)}
                    previewUrl={post.mediaItems?.[0]?.previewUrl}
                    renditionUrl={post.mediaItems?.[0]?.renditionUrl}
                    mediaKind={post.mediaKind}
                    textBody={post.postFormat === 'text' ? post.body || post.description : undefined}
                    badges={[post.visibility, ...(recipeLabel ? [recipeLabel] : [])]}
                    onClick={feedItem && post.canShare ? () => openPost(feedItem) : undefined}
                    href={!post.canShare ? post.ownerPath : undefined}
                    actionLabel={post.canShare ? 'View' : 'Edit'}
                  />
                );
              }) : savedSaveState.items.map((item) => {
                const cover = item.mediaItems?.slice().sort((left, right) => left.sortOrder - right.sortOrder)[0];
                return (
                  <MediaCard
                    key={item.id}
                    title={item.title}
                    subtitle={`${item.creator.name} · ${formatShortDate(item.savedAt || item.createdAt)}`}
                    mediaUrl={cover?.url || item.mediaUrl}
                    previewUrl={cover?.previewUrl}
                    renditionUrl={cover?.renditionUrl}
                    mediaKind={cover?.mediaKind || item.mediaKind}
                    textBody={item.postFormat === 'text' ? item.body || item.prompt : undefined}
                    badges={item.asset ? ['Recipe attached'] : undefined}
                    onClick={() => openPost(item)}
                    actionLabel="View"
                  />
                );
              })}
            </div>

            {errors[activeTab] ? <p className="mt-5 text-center text-sm text-rose-300">{errors[activeTab]}</p> : null}
            {hasMore ? (
              <div className="mt-6 flex justify-center">
                <button type="button" onClick={() => void loadMore()} disabled={loadingMoreTab !== null} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-5 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08] disabled:opacity-60">
                  {loadingMoreTab === activeTab ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers3 className="h-4 w-4" />}
                  {loadingMoreTab === activeTab ? 'Loading…' : `Load more ${activeTab}`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {selectedPostId ? (
        <ShowcaseReelViewer
          isOpen={viewerItems.some((item) => item.id === selectedPostId)}
          items={viewerItems}
          selectedItemId={selectedPostId}
          initialMediaIndex={selectedMediaIndex}
          savedItemIds={activeSaveState.savedItemIds}
          accessToken={accessToken}
          hasMoreItems={activePageInfo.hasMore}
          isLoadingMoreItems={loadingMoreTab === activeTab}
          loadMoreError={errors[activeTab] ?? null}
          onLoadMoreItems={loadMore}
          onClose={closePost}
          onSelectItemId={selectPost}
          onCommentCountChange={updateCommentCount}
          onMediaIndexChange={(index) => {
            setSelectedMediaIndex(index);
            updateLocation({ postId: selectedPostId, mediaIndex: index }, 'replace');
          }}
          onToggleSave={activeSaveState.toggleSave}
          onReportContent={activeTab === 'saved' ? handleSavedReportContent : undefined}
          onReportUser={activeTab === 'saved' ? handleSavedReportUser : undefined}
          onBlockUser={activeTab === 'saved' ? handleSavedBlockUser : undefined}
          originLabel="Profile"
          onRemix={async (id) => {
            if (!accessToken) return authRequired();
            const { redirectTo } = await requestShowcaseRemix({ accessToken, generationId: id });
            router.push(redirectTo);
          }}
          buildDetailPath={(id, section) => buildShowcaseDetailPath(id, {
            from: 'profile',
            returnTo: `/profile?tab=${activeTab}`,
            section,
          })}
        />
      ) : null}

      </section>
    </>
  );
}
