'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Heart, Image as ImageIcon, Video, Layers, TrendingUp, ShoppingBag, BookText, BadgeDollarSign, SlidersHorizontal, X, RefreshCw } from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import CreatorIdentity from '@/components/CreatorIdentity';
import NewPostsPill, { newPostsScrollBehavior } from '@/components/NewPostsPill';
import PublicShareButton from '@/components/PublicShareButton';
import SkeletonLoader from '@/components/SkeletonLoader';
import { useOptimisticPostSave } from '@/components/useOptimisticPostSave';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';
import {
    loadShowcaseReelViewer,
    warmShowcaseReelViewer,
} from '@/app/showcase/showcase-reel-loader';
import {
    FEED_REMOVAL_UNDO_MS,
    FEED_UNDO_FAILED_MESSAGE,
    FeedRemovalUndoRow,
    QualifiedImpressionBoundary,
    ShowcaseFeedbackMenu,
    feedRemovalLabel,
    getShowcaseFeedSessionId,
    putBackRemovedFeedItems,
    sendShowcaseFeedEvent,
    sendShowcaseResourceOpenEvent,
    undoShowcaseFeedFeedbackAfterHide,
    type FeedRemoval,
    type ShowcaseEventSourceSurface,
    type ShowcaseFeedbackAction,
} from '@/app/showcase/ShowcaseFeedInteraction';
import {
    SHOWCASE_INITIAL_RENDER_COUNT,
    SHOWCASE_PAGE_SIZE,
    type ShowcaseCategory,
    type ShowcaseFeedItem,
    type ShowcaseFeedPage,
    type ShowcaseMediaItem,
    type ShowcasePriorityPosterData,
    type ShowcaseResourceFilter,
    type ShowcaseSort,
    type ShowcaseUnlockFilter,
    getShowcaseItemMediaItems,
} from '@/lib/showcase';
import {
    formatPostResourcePriceLabel,
    getPostResourceKindLabel,
    isPostResourceKind,
    type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { buildShowcaseDetailPath, getCurrentInternalPath } from '@/lib/share';
import { requestShowcaseRemix } from '@/lib/showcase-remix-client';
import { getAssetAccessLabel } from '@/lib/showcase-asset-labels';
import { isTextOnlyPost } from '@/lib/post-feed-presentation';
import type { SourceToolFilterOption } from '@/lib/source-tools';
import {
    blockCreatorAfterConfirmation,
    reportCreatorAfterConfirmation,
    reportPostAfterConfirmation,
    type FeedSafetyOutcome,
} from '@/lib/feed-safety-actions';
import { mergeShowcaseFeedKeepingVisibleItems } from '@/lib/showcase-feed-stability';
import { fetchShowcaseViewerExclusions } from '@/lib/showcase-viewer-exclusions-client';
import {
    buildShowcaseClientCacheKey,
    claimVisitMemoryFor,
    filterFeedItemsForVisit,
    forgetFeedPreferenceForVisit,
    forgetShowcaseClientSnapshot,
    getCreatorsBlockedThisVisit,
    getFeedPreferencesHiddenThisVisit,
    readShowcaseClientSnapshotToRestore,
    rememberViewerExclusionsForVisit,
    writeShowcaseClientSnapshot,
    type ShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';
import { feedNewestCategoryFor, newestCreatedAtOf, useNewPostsProbe, type NewPostsProbeLane } from '@/lib/feed-newest-probe';
import { scheduleIdleWork } from '@/lib/schedule-idle-work';
import { useMediaQuery } from '@/lib/use-media-query';

function ShowcaseReelLoadingFallback() {
    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 text-sm font-bold text-white backdrop-blur-sm"
        >
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-950 px-5 py-3 shadow-2xl">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Opening preview
            </span>
        </div>
    );
}

const ShowcaseReelViewer = dynamic(
    () => loadShowcaseReelViewer(),
    {
        ssr: false,
        loading: ShowcaseReelLoadingFallback,
    }
);

const CATEGORIES: Array<{
    id: ShowcaseCategory;
    label: string;
    icon: typeof Layers;
}> = [
    { id: 'all', label: 'All posts', icon: Layers },
    { id: 'image', label: 'Images', icon: ImageIcon },
    { id: 'video', label: 'Videos', icon: Video },
];

const SORTS: Array<{ id: ShowcaseSort; label: string }> = [
    { id: 'for-you', label: 'For you' },
    { id: 'recent', label: 'Recent' },
    { id: 'top-saves', label: 'Saved' },
    { id: 'top-remixes', label: 'Remixed' },
    { id: 'top-sales', label: 'Sales' },
];

const DEFAULT_SHOWCASE_SORT: ShowcaseSort = 'for-you';
// One responsive grid row per tick keeps hydration work batched while filling
// the grid faster than anyone scrolls. Reveals ride transitions, so input
// stays responsive; the cadence only paces mounting, never data fetching.
const SHOWCASE_DEFERRED_REVEAL_TICK_MS = 160;
const SHOWCASE_REEL_WARM_IDLE_TIMEOUT_MS = 2_000;
const SHOWCASE_SNAPSHOT_IDLE_TIMEOUT_MS = 1_000;
const SHOWCASE_ANONYMOUS_REFRESH_IDLE_TIMEOUT_MS = 3_000;
const SHOWCASE_REFRESH_RETRY_BASE_MS = 2_000;
const SHOWCASE_REFRESH_MAX_RETRIES = 2;

function getShowcaseDeferredRevealBatchSize(): number {
    if (typeof window.matchMedia !== 'function') {
        return 1;
    }

    // Match the responsive column counts used by the stable showcase grid.
    // Revealing one complete row fills desktop space predictably while
    // preserving one-at-a-time hydration on the mobile performance path.
    if (window.matchMedia('(min-width: 1280px)').matches) {
        return 4;
    }
    if (window.matchMedia('(min-width: 1024px)').matches) {
        return 3;
    }
    if (window.matchMedia('(min-width: 640px)').matches) {
        return 2;
    }
    return 1;
}

const SHOWCASE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
});

function formatShowcaseDate(value: string): string {
    return SHOWCASE_DATE_FORMATTER.format(new Date(value));
}

const UNLOCK_FILTERS: Array<{ id: ShowcaseUnlockFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'with-unlock', label: 'Unlocks' },
    { id: 'free', label: 'Free' },
    { id: 'paid', label: 'Paid' },
];

const RESOURCE_FILTERS: Array<{ id: ShowcaseResourceFilter; label: string }> = [
    { id: 'all', label: 'All kinds' },
    { id: 'prompt', label: 'Prompts' },
    { id: 'workflow', label: 'Workflows' },
    { id: 'files', label: 'Files' },
    { id: 'notes', label: 'Notes' },
    { id: 'remix', label: 'Remixable' },
];

export interface ShowcaseClientProps {
    initialFeed: ShowcaseFeedPage;
    initialCategory: ShowcaseCategory;
    initialSort: ShowcaseSort;
    initialTool: string | null;
    initialUnlock: ShowcaseUnlockFilter;
    initialResource: ShowcaseResourceFilter;
    sourceToolOptions: SourceToolFilterOption[];
    initialPriorityPoster?: ShowcasePriorityPosterData | null;
    /**
     * The post whose history entry the bootstrap shell pushed for the tap
     * that loaded this client (`ShowcaseBootstrapClient`). The address names
     * it at mount, as a shared link's would, but the entry under it is
     * Explore's: the reel is treated as opened from a tile, and Explore goes
     * Back to that entry instead of replacing the pushed one.
     */
    initialPushedPostId?: string | null;
}

function getItemResourceKinds(item: ShowcaseFeedItem): PostResourceKind[] {
    return (item.asset?.resourceKinds ?? []).filter(isPostResourceKind);
}

function getAssetPurchaseCtaLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
    if (asset.accessMode === 'free' || asset.priceUsdCents === 0) {
        return 'View free recipe';
    }

    return `Unlock for ${formatPostResourcePriceLabel(asset.priceUsdCents, asset.priceQuote?.formatted)}`;
}

/**
 * Explore is the media grid, so its requests ask the server for media when the
 * lane is "all" (the URL keeps `all`). It used to fetch every post and drop the
 * text ones in the browser: a lane of text posts drew a blank grid with no
 * message, and each page carried posts the grid threw away.
 */
function requestCategoryFor(category: ShowcaseCategory): ShowcaseCategory {
    return category === 'all' ? 'media' : category;
}

function setNonDefaultParam(params: URLSearchParams, key: string, value: string, defaultValue: string) {
    if (value !== defaultValue) {
        params.set(key, value);
    }
}


function isSessionHiddenItem(
    item: ShowcaseFeedItem,
    hiddenPostIds: Set<string>,
    hiddenCreatorIds: Set<string>
) {
    return hiddenPostIds.has(item.id)
        || Boolean(item.creator.id && hiddenCreatorIds.has(item.creator.id));
}

function filterSessionHiddenItems(
    feedItems: ShowcaseFeedItem[],
    hiddenPostIds: Set<string>,
    hiddenCreatorIds: Set<string>
) {
    return feedItems.filter((item) => !isSessionHiddenItem(item, hiddenPostIds, hiddenCreatorIds));
}

/**
 * The post a reel moves to when the one it has open is taken out: the first
 * one left after it, else the last one left before it. Picked by post from the
 * list as it was, not by index from what is left, so a hidden creator's
 * earlier posts going too do not skip the post after the open one.
 */
function pickReelReplacement(
    feedItems: ShowcaseFeedItem[],
    openPosition: number,
    isRemoved: (candidate: ShowcaseFeedItem) => boolean
): ShowcaseFeedItem | null {
    return feedItems.slice(openPosition + 1).find((candidate) => !isRemoved(candidate))
        ?? feedItems.slice(0, openPosition).reverse().find((candidate) => !isRemoved(candidate))
        ?? null;
}

/**
 * The grid's tiles with the "Hidden · Undo" row in the cell of a tile Not
 * interested or Hide just took out (D7): the tiles after it stay in their
 * cells until the removal stands.
 */
function withRemovalRow(tiles: ReactNode[], rowIndex: number | null, row: ReactNode): ReactNode[] {
    if (rowIndex === null) {
        return tiles;
    }
    const cells = tiles.slice();
    cells.splice(Math.min(rowIndex, cells.length), 0, row);
    return cells;
}

/**
 * The path of an Explore lane: its filters, each named only when it is not
 * the default. A lane change goes there, and a tile's links come back there.
 */
function buildShowcaseLanePath(
    pathname: string,
    lane: {
        category: ShowcaseCategory;
        sort: ShowcaseSort;
        tool: string;
        unlock: ShowcaseUnlockFilter;
        resource: ShowcaseResourceFilter;
    }
): string {
    const params = new URLSearchParams();

    if (lane.category !== 'all') {
        params.set('category', lane.category);
    }

    if (lane.sort !== DEFAULT_SHOWCASE_SORT) {
        params.set('sort', lane.sort);
    }

    if (lane.tool && lane.tool !== 'all') {
        params.set('tool', lane.tool);
    }

    if (lane.unlock !== 'all') {
        params.set('unlock', lane.unlock);
    }

    if (lane.resource !== 'all') {
        params.set('resource', lane.resource);
    }

    return params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
}

/**
 * Where nothing hovers, Explore plays one tile's clip: a phone saw still tiles
 * while Home played its cards and the app's Explore its one preview. Each step
 * reports a tile's share of the screen again, so the choice follows the scroll.
 */
const VIDEO_TILE_VISIBILITY_STEPS = Array.from({ length: 11 }, (_, step) => step / 10);

interface VideoTileVisibility {
    id: string;
    /** The frame's share in view at its last reported step; 0 off screen. */
    ratio: number;
}

/**
 * A tile opens on its cover, and the carousel streams a feed clip only where
 * the server allowed one (a null `feedStreamUrl` is poster only) and the
 * source is still there. A tile without one never takes the playing turn.
 */
function coverPlaysInGrid(cover: ShowcaseMediaItem | undefined): boolean {
    return Boolean(
        cover
        && cover.mediaKind === 'video'
        && !cover.sourceUnavailableAt
        && (cover.feedStreamUrl === undefined || cover.feedStreamUrl)
    );
}

/**
 * The tile most in view. A row's tiles share a height and cross each step
 * together, so a tie keeps the tile already playing, else goes to the first
 * in the grid.
 */
function pickMostVisibleVideoTile(
    tiles: ReadonlyMap<Element, VideoTileVisibility>,
    playingId: string | null
): string | null {
    let best: { frame: Element; tile: VideoTileVisibility } | null = null;
    for (const [frame, tile] of tiles) {
        if (tile.ratio <= 0) {
            continue;
        }
        const wins = !best
            || tile.ratio > best.tile.ratio
            || (tile.ratio === best.tile.ratio && best.tile.id !== playingId && (
                tile.id === playingId
                || Boolean(frame.compareDocumentPosition(best.frame) & Node.DOCUMENT_POSITION_FOLLOWING)
            ));
        if (wins) {
            best = { frame, tile };
        }
    }
    return best?.tile.id ?? null;
}

/**
 * The tile whose clip the grid plays (none until one is in view, and none
 * while `enabled` is off), and what a tile whose cover is a clip calls from
 * its ref to hand its frame to the one observer that measures them all. The
 * carousel still refuses motion under Save-Data and reduced motion, as on Home.
 */
function useMostVisibleVideoTile(enabled: boolean) {
    const [playingId, setPlayingId] = useState<string | null>(null);
    const playingIdRef = useRef<string | null>(null);
    const tilesRef = useRef(new Map<Element, VideoTileVisibility>());
    const observerRef = useRef<IntersectionObserver | null>(null);

    const elect = useCallback(() => {
        const nextId = pickMostVisibleVideoTile(tilesRef.current, playingIdRef.current);
        if (nextId === playingIdRef.current) {
            return;
        }
        playingIdRef.current = nextId;
        setPlayingId(nextId);
    }, []);

    useEffect(() => {
        if (!enabled || typeof IntersectionObserver === 'undefined') {
            return;
        }

        const tiles = tilesRef.current;
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const tile = tiles.get(entry.target);
                if (tile) {
                    tile.ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
                }
            }
            elect();
        }, { threshold: VIDEO_TILE_VISIBILITY_STEPS });
        observerRef.current = observer;
        // Tiles drawn before the observer (the first page, at hydration) are
        // measured from here; later ones as they mount.
        tiles.forEach((_tile, frame) => observer.observe(frame));

        return () => {
            observer.disconnect();
            observerRef.current = null;
            tiles.forEach((tile) => {
                tile.ratio = 0;
            });
            elect();
        };
    }, [elect, enabled]);

    const observeVideoTile = useCallback((id: string, frame: Element) => {
        const tiles = tilesRef.current;
        tiles.set(frame, { id, ratio: 0 });
        observerRef.current?.observe(frame);
        return () => {
            tiles.delete(frame);
            observerRef.current?.unobserve(frame);
            // A playing tile that leaves the grid (hidden, reported, another
            // lane) hands its turn on at once, not at the next scroll step.
            if (playingIdRef.current === id) {
                elect();
            }
        };
    }, [elect]);

    return [playingId, observeVideoTile] as const;
}

interface ShowcaseGridCardProps {
    item: ShowcaseFeedItem;
    index: number;
    isSaved: boolean;
    isPriority: boolean;
    priorityPoster: ShowcasePriorityPosterData | null;
    feedSessionId: string | null;
    accessToken: string | null;
    viewerId: string | null;
    /** The lane the tile's links come back to (`buildShowcaseLanePath`). */
    returnTo: string;
    /** This tile's clip is the one the grid plays (`useMostVisibleVideoTile`). */
    autoPlayVideo: boolean;
    observeVideoTile: (id: string, frame: Element) => () => void;
    onOpenPreview: (item: ShowcaseFeedItem, mediaIndex: number) => void;
    onToggleSave: (id: string) => void;
    onFeedback: (
        item: ShowcaseFeedItem,
        action: ShowcaseFeedbackAction,
        sourceSurface: ShowcaseEventSourceSurface
    ) => Promise<void>;
    onReportContent: (item: ShowcaseFeedItem, surface: 'explore' | 'reel') => Promise<void>;
    onReportUser: (item: ShowcaseFeedItem, surface: 'explore' | 'reel') => Promise<void>;
    onBlockUser: (item: ShowcaseFeedItem) => Promise<void>;
}

/**
 * One Explore tile. The grid is not windowed, and the page around it renders
 * again at every reel landing, media swipe, save and reveal tick: a tile drawn
 * inline was drawn again each time, every tile, down to its carousel and menu.
 * Memoised, it draws again only when what it shows changes. So its props are
 * values, and functions kept across renders; the reel's post and slide, which
 * the page's URL carries, are not among them.
 */
const ShowcaseGridCard = memo(function ShowcaseGridCard({
    item,
    index,
    isSaved,
    isPriority,
    priorityPoster,
    feedSessionId,
    accessToken,
    viewerId,
    returnTo,
    autoPlayVideo,
    observeVideoTile,
    onOpenPreview,
    onToggleSave,
    onFeedback,
    onReportContent,
    onReportUser,
    onBlockUser,
}: ShowcaseGridCardProps) {
    const resourceKinds = getItemResourceKinds(item);
    const mediaItems = useMemo(() => getShowcaseItemMediaItems(item), [item]);
    const isMixedMedia = new Set(mediaItems.map((mediaItem) => mediaItem.mediaKind)).size > 1;
    const isOwnPost = Boolean(viewerId && item.creator.id === viewerId);
    const coverPlays = coverPlaysInGrid(mediaItems[0]);
    const measureVideoFrame = useCallback(
        (frame: HTMLDivElement | null) => (frame && coverPlays ? observeVideoTile(item.id, frame) : undefined),
        [coverPlays, item.id, observeVideoTile]
    );

    return (
        <QualifiedImpressionBoundary
            item={item}
            position={index}
            feedSessionId={feedSessionId}
            accessToken={accessToken}
            className="flex min-w-0 flex-col [content-visibility:auto] [contain-intrinsic-size:auto_520px]"
        >
            {/* Pinterest Style Card Frame */}
            <div className="group relative overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] transition duration-200 hover:border-[rgba(255,122,89,0.28)] hover:shadow-[0_12px_40px_rgba(0,0,0,0.42)] focus-within:border-[rgba(255,122,89,0.34)]">
                <div ref={measureVideoFrame} className="relative overflow-hidden bg-black">
                    {mediaItems.length > 0 ? (
                        <ShowcaseMediaCarousel
                            mediaItems={mediaItems}
                            title={item.title}
                            priority={isPriority}
                            priorityPoster={priorityPoster}
                            autoPlayVideo={autoPlayVideo || undefined}
                            onOpen={(mediaIndex) => onOpenPreview(item, mediaIndex)}
                        />
                    ) : (
                        <div className="flex min-h-[240px] items-center justify-center bg-zinc-950 text-zinc-500">
                            <BookText className="h-10 w-10" />
                        </div>
                    )}
                </div>

                {/* Hover State Controls Overlay (Pinterest Style) */}
                <div className="showcase-card-actions pointer-events-none absolute inset-0 z-20 flex flex-col justify-between bg-gradient-to-t from-black/70 via-transparent to-transparent p-3 transition-opacity duration-200">
                    <div className="flex justify-between items-start pointer-events-auto">
                        <div className="px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full text-[11px] font-medium border border-white/10 flex items-center gap-1.5 text-white">
                            <span>{isMixedMedia ? 'Mixed' : item.category}</span>
                        </div>
                        {/* The feed card's five rows. Not on the viewer's own
                            post: nothing there to hide, report or block. */}
                        <ShowcaseFeedbackMenu
                            portal
                            itemTitle={item.title}
                            creator={item.creator}
                            canHideCreator={Boolean(
                                item.creator.id && item.creator.id !== viewerId
                            )}
                            sessionOnly={!viewerId}
                            onSelect={(action) => onFeedback(item, action, 'showcase')}
                            onReportContent={isOwnPost
                                ? undefined
                                : () => void onReportContent(item, 'explore')}
                            onReportUser={() => void onReportUser(item, 'explore')}
                            onBlockUser={() => void onBlockUser(item)}
                        />
                    </div>

                    <div className="flex items-center justify-end gap-2 pointer-events-auto">
                        <PublicShareButton
                            generationId={item.id}
                            title={item.title}
                            description={item.body || item.prompt}
                            sourceSurface="showcase"
                            accessToken={accessToken}
                            viewerIsOwner={isOwnPost}
                            onShared={() => {
                                void sendShowcaseFeedEvent({
                                    item,
                                    eventType: 'share',
                                    sourceSurface: 'showcase',
                                    accessToken,
                                    feedSessionId,
                                    fallbackPosition: index,
                                }).catch(() => undefined);
                            }}
                            iconOnly
                            className="ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ui-text-primary)] text-[var(--ui-primary-on)] shadow-md transition hover:bg-white"
                        />

                        {item.asset ? (
                            <Link
                                href={buildShowcaseDetailPath(item.id, {
                                    from: 'community',
                                    returnTo,
                                    section: 'resources',
                                })}
                                prefetch={false}
                                // The tile's resources opened: once per delivery.
                                onClick={() => sendShowcaseResourceOpenEvent({
                                    item,
                                    sourceSurface: 'showcase',
                                    accessToken,
                                    feedSessionId,
                                    fallbackPosition: index,
                                })}
                                className="ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full bg-amber-400 text-[#1a0d08] shadow-md transition hover:bg-amber-300"
                                aria-label={`${getAssetPurchaseCtaLabel(item.asset)} for ${item.title}`}
                                title={getAssetPurchaseCtaLabel(item.asset)}
                            >
                                <ShoppingBag className="h-4.5 w-4.5" />
                            </Link>
                        ) : null}

                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleSave(item.id);
                            }}
                            aria-label={`${isSaved ? 'Remove save from' : 'Save'} ${item.title}. ${item.saveCount} saves`}
                            aria-pressed={isSaved}
                            className={`ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full shadow-md transition ${
                                isSaved
                                    ? 'bg-rose-600 text-white hover:bg-rose-700'
                                    : 'bg-[var(--ui-text-primary)] text-[var(--ui-primary-on)] hover:bg-white'
                            }`}
                            title={isSaved ? 'Remove save' : 'Save'}
                        >
                            <Heart className={`h-4 w-4 ${isSaved ? 'fill-current' : ''}`} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Pinterest Style Meta Details Under the Card */}
            <div className="mt-3 px-1.5 flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-zinc-100 text-sm leading-snug line-clamp-1 flex-1">
                        {item.title}
                    </h3>
                    <span className="text-[10px] text-zinc-500 font-semibold whitespace-nowrap mt-0.5">
                        {formatShowcaseDate(item.createdAt)}
                    </span>
                </div>

                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                        <CreatorIdentity creator={item.creator} compact prefetch={false} />
                    </div>
                    <div className="flex items-center gap-1 text-zinc-500 text-[11px] font-semibold">
                        <Heart className={`w-3.5 h-3.5 ${isSaved ? 'fill-[var(--ui-primary)] text-[var(--ui-primary)]' : ''}`} />
                        <span>{item.saveCount}</span>
                    </div>
                </div>

                {/* Recipe and resource badges */}
                {(item.asset || resourceKinds.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        {item.asset ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/10 bg-emerald-500/[0.06] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                                {getAssetAccessLabel(item.asset)}
                            </span>
                        ) : null}
                        {resourceKinds.map((kind) => (
                            <span
                                key={`${item.id}-${kind}`}
                                className="rounded-full border border-white/5 bg-white/[0.02] px-2 py-0.5 text-[10px] font-bold tracking-wider text-zinc-400 uppercase"
                            >
                                {getPostResourceKindLabel(kind)}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </QualifiedImpressionBoundary>
    );
});

export default function ShowcaseClient({
    initialFeed,
    initialCategory,
    initialSort,
    initialTool,
    initialUnlock,
    initialResource,
    sourceToolOptions,
    initialPriorityPoster = null,
    initialPushedPostId = null,
}: ShowcaseClientProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { session, user, isLoading: isAuthLoading } = useAuth();
    // `isPending` turns the lane controls off while a lane change is under
    // way. The reveal ticks use React's own `startTransition`, which has no
    // pending state: through this one every tick committed the page once more,
    // synchronously, only to turn the controls off and on again.
    const [isPending, startLaneTransition] = useTransition();
    const showcaseClientCacheKey = buildShowcaseClientCacheKey({
        viewerId: user?.id ?? null,
        category: initialCategory,
        sort: initialSort,
        tool: initialTool,
        unlock: initialUnlock,
        resource: initialResource,
    });
    const [restoredClientState] = useState(() => {
        const cacheKey = buildShowcaseClientCacheKey({
            viewerId: user?.id ?? null,
            category: initialCategory,
            sort: initialSort,
            tool: initialTool,
            unlock: initialUnlock,
            resource: initialResource,
        });
        const snapshot = readShowcaseClientSnapshotToRestore(cacheKey);
        if (!snapshot) {
            // The server builds this first page for everyone. What this tab
            // already knows the viewer's own feed leaves out is not drawn from
            // it: a creator blocked on another page a moment ago, and what the
            // server answered the last time this page asked (below).
            const visibleItems = filterFeedItemsForVisit(initialFeed.items, {
                forYou: initialSort === DEFAULT_SHOWCASE_SORT,
                viewerId: user?.id ?? null,
            });
            return {
                snapshot: null,
                feed: visibleItems === initialFeed.items ? initialFeed : { ...initialFeed, items: visibleItems },
            };
        }

        const restoredSavedItemIds = new Set(snapshot.savedItemIds);
        return {
            snapshot,
            feed: {
                ...snapshot.feed,
                items: snapshot.feed.items.map((item) => ({
                    ...item,
                    isSaved: restoredSavedItemIds.has(item.id),
                })),
            },
        };
    });
    const restoredInitialFeed = restoredClientState.feed;
    // The saved-state lookup asks about the lane's first page: the one this
    // grid opened with, then the page each lane change brings. Those pages are
    // built for everyone, so none of their posts arrives marked saved, and a
    // lane changed to drew the viewer's saved posts with an empty heart.
    const [openedWithFeed] = useState(initialFeed);
    const laneFirstPageItems = initialFeed === openedWithFeed ? restoredInitialFeed.items : initialFeed.items;
    const feedItemsForEventsRef = useRef<ShowcaseFeedItem[]>(restoredInitialFeed.items);
    const feedSessionIdForEventsRef = useRef<string | null>(getShowcaseFeedSessionId(restoredInitialFeed));
    const {
        items,
        setItems,
        savedItemIds,
        setSavedItemIds,
        toggleSave,
    } = useOptimisticPostSave({
        initialItems: laneFirstPageItems,
        accessToken: session?.access_token ?? null,
        isSignedIn: Boolean(user && session?.access_token),
        onAuthRequired: () => router.push(
            `/login?returnUrl=${encodeURIComponent(getCurrentInternalPath('/showcase'))}`
        ),
        onError: (error) => console.error('Save failed:', error),
        onSuccess: ({ id, isSaved, sourceSurface }) => {
            const savedItem = feedItemsForEventsRef.current.find((candidate) => candidate.id === id);
            const itemPosition = feedItemsForEventsRef.current.findIndex((candidate) => candidate.id === id);
            if (!savedItem) {
                return;
            }

            return sendShowcaseFeedEvent({
                item: savedItem,
                eventType: isSaved ? 'save' : 'unsave',
                sourceSurface: sourceSurface === 'showcase-reel' ? 'showcase-reel' : 'showcase',
                accessToken: session?.access_token ?? null,
                feedSessionId: feedSessionIdForEventsRef.current,
                fallbackPosition: itemPosition >= 0 ? itemPosition : undefined,
            });
        },
        sourceSurface: 'showcase',
    });
    const [category, setCategory] = useState(initialCategory);
    const [sort, setSort] = useState(initialSort);
    const [tool, setTool] = useState(initialTool ?? 'all');
    const [unlock, setUnlock] = useState<ShowcaseUnlockFilter>(initialUnlock);
    const [resource, setResource] = useState<ShowcaseResourceFilter>(initialResource);
    const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
    const [pageInfo, setPageInfo] = useState(restoredInitialFeed.pageInfo);
    const [feedSessionId, setFeedSessionId] = useState(() => getShowcaseFeedSessionId(restoredInitialFeed));
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [isRefreshingLane, setIsRefreshingLane] = useState(false);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    // A `?post=` link to a post outside the loaded pages: read on its own, and
    // the reel opens on the read (loading, gone, failed) rather than on nothing.
    const [directPostStatus, setDirectPostStatus] = useState<'loading' | 'unavailable' | 'failed' | null>(null);
    const [directPostAttempt, setDirectPostAttempt] = useState(0);
    const [renderedItemCount, setRenderedItemCount] = useState(() => (
        Math.min(
            restoredClientState.snapshot?.renderedItemCount ?? SHOWCASE_INITIAL_RENDER_COUNT,
            restoredInitialFeed.items.length
        )
    ));
    const renderedItemCountRef = useRef(renderedItemCount);
    const [hasAnonymousPersonalizationDemand, setHasAnonymousPersonalizationDemand] = useState(() => (
        Boolean(searchParams.get('post'))
    ));
    // Load More asks the For you refresh to run again after it gave up.
    const [personalizedRefreshRequest, setPersonalizedRefreshRequest] = useState(0);
    const [feedbackNotice, setFeedbackNotice] = useState<{
        tone: 'success' | 'error';
        message: string;
    } | null>(null);
    // The tile a Not interested or Hide just took out, while its cell offers Undo.
    const [tileRemoval, setTileRemoval] = useState<FeedRemoval<ShowcaseFeedItem> | null>(null);
    const removalIdRef = useRef(0);
    // Removals the reader took back: their hide's answer, when it comes, changes nothing on screen.
    const undoneRemovalIdsRef = useRef(new Set<number>());
    // When the lane's first page was fetched, for the "New posts" probe (D2):
    // a kept grid's is no later than when it was kept; the server's page
    // counts from the mount (null).
    const [laneFetchedAt, setLaneFetchedAt] = useState<number | null>(
        () => restoredClientState.snapshot?.cachedAt ?? null
    );
    const [selectedMediaIndex, setSelectedMediaIndex] = useState(() => {
        const value = Number(searchParams.get('media'));
        return Number.isInteger(value) && value >= 0 ? value : 0;
    });
    const isLoadingMoreRef = useRef(false);
    // Bumped by the server-page reset so a load-more reply for the old lane is dropped.
    const loadMoreGenerationRef = useRef(0);
    // Posts and creators taken out of the grid for the rest of this visit: a
    // guest's feed preferences, and anything anyone reported or blocked. Every
    // later page and refresh is filtered by them (`filterSessionHiddenItems`),
    // for a signed-in viewer too: the server's feed leaves out what they marked
    // not interested or hid, but not a post they reported.
    // They begin with what this tab already knows: the creators blocked on
    // other pages since it loaded, and on For you what the server has said the
    // viewer hid or marked not interested.
    const sessionHiddenPostIdsRef = useRef(new Set<string>(
        initialSort === DEFAULT_SHOWCASE_SORT ? getFeedPreferencesHiddenThisVisit(user?.id ?? null).postIds : []
    ));
    const sessionHiddenCreatorIdsRef = useRef(new Set<string>([
        ...getCreatorsBlockedThisVisit(user?.id ?? null),
        ...(initialSort === DEFAULT_SHOWCASE_SORT ? getFeedPreferencesHiddenThisVisit(user?.id ?? null).creatorIds : []),
    ]));
    const anonymousPersonalizationStartedRef = useRef(false);
    // The viewer's own For you page: on its way (asked for, or waiting on idle
    // or a retry), and come for this lane. Until it comes, For you's first page
    // has no cursor, and the viewer's page is what Load More shows next.
    const personalizedRefreshPendingRef = useRef(false);
    const personalizedRefreshLandedRef = useRef(false);
    const pageInfoRef = useRef(restoredInitialFeed.pageInfo);
    const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
    // An address naming a post at mount opened the reel by address (direct:
    // Explore replaces the entry), unless the bootstrap shell pushed that
    // entry for the tap that loaded this client: then the reel is pushed, as
    // from a tile, and Explore goes Back to the shell's entry under it.
    const initialPostParam = searchParams.get('post');
    const reelHistoryModeRef = useRef<'pushed' | 'direct' | null>(
        !initialPostParam
            ? null
            : initialPostParam === initialPushedPostId ? 'pushed' : 'direct'
    );
    // The post a close is taking out of the URL. The reel closes at once,
    // but the URL keeps the post until the browser's Back comes (popstate,
    // a task later) or Next applies the replace: a page landing in between
    // ran the URL effect on that URL and opened the reel again.
    const closingPostIdRef = useRef<string | null>(null);
    const directPostRequestRef = useRef<string | null>(null);
    const selectedItemIdRef = useRef<string | null>(selectedItemId);
    const pendingSnapshotRef = useRef<{
        key: string;
        snapshot: Omit<ShowcaseClientSnapshot, 'cachedAt'>;
    } | null>(null);
    const flushShowcaseSnapshot = useCallback(() => {
        const pending = pendingSnapshotRef.current;
        if (!pending) {
            return;
        }

        pendingSnapshotRef.current = null;
        writeShowcaseClientSnapshot(pending.key, pending.snapshot);
    }, []);
    const initialSnapshotRef = useRef({
        initialFeed,
        initialCategory,
        initialSort,
        initialTool,
        initialUnlock,
        initialResource,
        // The id, not the object: the auth provider replaces `user` at every token refresh.
        userId: user?.id ?? null,
    });

    useEffect(() => {
        selectedItemIdRef.current = selectedItemId;
        feedItemsForEventsRef.current = items;
        feedSessionIdForEventsRef.current = feedSessionId;
        renderedItemCountRef.current = renderedItemCount;
        pageInfoRef.current = pageInfo;
    }, [feedSessionId, items, pageInfo, renderedItemCount, selectedItemId]);

    useEffect(() => (
        scheduleIdleWork(warmShowcaseReelViewer, SHOWCASE_REEL_WARM_IDLE_TIMEOUT_MS)
    ), []);

    // A post page goes back to the lane, named by its filters alone. The URL
    // also carries the reel's post and slide, which change at every landing: a
    // way back read from it made every tile's props new at each one, though
    // `buildShowcaseDetailPath` drops both from the link. The lane is the one
    // the grid holds, from the props: the local filters run ahead of them
    // while a lane change is on its way, and would draw every tile of the old
    // lane again in the tap's own render.
    const laneReturnPath = useMemo(() => buildShowcaseLanePath(pathname, {
        category: initialCategory,
        sort: initialSort,
        tool: initialTool ?? 'all',
        unlock: initialUnlock,
        resource: initialResource,
    }), [initialCategory, initialResource, initialSort, initialTool, initialUnlock, pathname]);
    const buildCommunityDetailPath = useCallback((id: string, section?: string) => (
        buildShowcaseDetailPath(id, {
            from: 'community',
            returnTo: laneReturnPath,
            section,
        })
    ), [laneReturnPath]);
    const isLoadingInitialFeed = isPending && items.length === 0 && !isAuthLoading;
    // Showcase is the media grid. A text-only post has nothing to put in a tile,
    // so it lives on /feed, which renders a written post at full width.
    const tileableItems = items.filter((item) => !isTextOnlyPost(item));
    const renderedItems = tileableItems.slice(0, renderedItemCount);
    const hasDeferredItems = renderedItemCount < tileableItems.length;
    const hasAuthenticatedSession = Boolean(user && session?.access_token);
    // Effects key on the user id, not on the session or user objects: the auth
    // provider replaces both at every token refresh, and the token itself
    // changes then too, so the refresh effect reads it through a ref.
    const accessToken = session?.access_token ?? null;
    const accessTokenRef = useRef(accessToken);
    accessTokenRef.current = accessToken;
    const userId = user?.id ?? null;

    // What the tab remembers of a viewer's blocks and preferences is theirs:
    // once it is known who is looking, anyone else's is dropped. Signing out,
    // or in as someone else, does not reload the page.
    useEffect(() => {
        if (!isAuthLoading) {
            claimVisitMemoryFor(userId);
        }
    }, [isAuthLoading, userId]);

    // The first page is the server's for everyone, and the viewer's own feed is
    // merged in under the rows already drawn, so nothing took out of those rows
    // what the viewer's own feed leaves out: a creator they blocked or hid was
    // back on screen after every reload. Ask about the posts this page drew,
    // and take out the ones the server names. Blocks hold on every lane; Hide
    // and Not interested are For you's, as on the server. A post open in the
    // reel stays while the reel is open (the effect after this one).
    useEffect(() => {
        if (isAuthLoading || !hasAuthenticatedSession || !userId || !accessTokenRef.current) {
            return;
        }

        const drawnItems = [...new Map(
            [...feedItemsForEventsRef.current, ...initialFeed.items].map((item) => [item.id, item])
        ).values()];
        const controller = new AbortController();
        void fetchShowcaseViewerExclusions({
            items: drawnItems,
            accessToken: accessTokenRef.current,
            signal: controller.signal,
        }).then((exclusions) => {
            if (!exclusions || controller.signal.aborted) {
                return;
            }

            rememberViewerExclusionsForVisit(userId, exclusions);
            exclusions.blockedCreatorIds.forEach((id) => sessionHiddenCreatorIdsRef.current.add(id));
            if (initialSort === DEFAULT_SHOWCASE_SORT) {
                exclusions.hiddenCreatorIds.forEach((id) => sessionHiddenCreatorIdsRef.current.add(id));
                exclusions.hiddenPostIds.forEach((id) => sessionHiddenPostIdsRef.current.add(id));
            }
            setItems((latestItems) => {
                const openItemId = selectedItemIdRef.current;
                const visibleItems = latestItems.filter((item) => (
                    item.id === openItemId
                    || !isSessionHiddenItem(item, sessionHiddenPostIdsRef.current, sessionHiddenCreatorIdsRef.current)
                ));
                return visibleItems.length === latestItems.length ? latestItems : visibleItems;
            });
        });

        return () => controller.abort();
    }, [hasAuthenticatedSession, initialFeed, initialSort, isAuthLoading, setItems, userId]);

    // A post that was left on the page because the viewer had it open in the
    // reel goes once the reel is closed: its tile would be a blocked or hidden
    // creator's post back in the grid. Only on a close: the page as first drawn
    // is already without them. Nothing to do on most closes, and then the list
    // is handed back as it is.
    const reelWasOpenRef = useRef(false);
    useEffect(() => {
        if (selectedItemId) {
            reelWasOpenRef.current = true;
            return;
        }
        if (!reelWasOpenRef.current) {
            return;
        }

        reelWasOpenRef.current = false;
        setItems((latestItems) => {
            const visibleItems = latestItems.filter((item) => (
                !isSessionHiddenItem(item, sessionHiddenPostIdsRef.current, sessionHiddenCreatorIdsRef.current)
            ));
            return visibleItems.length === latestItems.length ? latestItems : visibleItems;
        });
    }, [selectedItemId, setItems]);
    const priorityMediaItemId = renderedItems.find((item) => (
        item.postFormat !== 'text' && getShowcaseItemMediaItems(item).length > 0
    ))?.id ?? null;
    // Where nothing hovers, one tile's clip plays, as on Home (FeedClient's
    // `touchAutoplay`); pointers keep hover and focus. None while the reel is
    // open over the grid: it plays its own, and a tile under it would stream
    // unseen.
    const touchAutoplay = useMediaQuery('(hover: none)');
    const [mostVisibleVideoTileId, observeVideoTile] = useMostVisibleVideoTile(touchAutoplay);
    const playingTileId = selectedItemId ? null : mostVisibleVideoTileId;

    useEffect(() => {
        const itemsWithSavedState = items.map((item) => ({
            ...item,
            isSaved: savedItemIds.has(item.id),
        }));
        pendingSnapshotRef.current = {
            key: showcaseClientCacheKey,
            snapshot: {
                feed: {
                    ...initialFeed,
                    items: itemsWithSavedState,
                    pageInfo,
                    feedSessionId,
                },
                renderedItemCount,
                savedItemIds: [...savedItemIds],
            },
        };
        // Writing here means serializing the whole feed and touching
        // sessionStorage synchronously — tens of KB that grow with every page
        // loaded. `renderedItemCount` changes on every reveal tick, so doing it
        // eagerly would put that stall between each row of cards. Returning the
        // canceller debounces to the last change, and this is only a
        // back-navigation restore cache, so idle is soon enough.
        return scheduleIdleWork(flushShowcaseSnapshot, SHOWCASE_SNAPSHOT_IDLE_TIMEOUT_MS);
    }, [
        feedSessionId,
        flushShowcaseSnapshot,
        initialFeed,
        items,
        pageInfo,
        renderedItemCount,
        savedItemIds,
        showcaseClientCacheKey,
    ]);

    // A viewer leaving the page is exactly who the restore cache is for, and
    // the debounced write may still be pending.
    useEffect(() => flushShowcaseSnapshot, [flushShowcaseSnapshot]);

    useEffect(() => {
        const postParam = searchParams.get('post');
        // A close on its way: until the URL moves on, it names the post the
        // reader just closed.
        if (closingPostIdRef.current !== null) {
            if (postParam === closingPostIdRef.current) {
                return;
            }
            closingPostIdRef.current = null;
        }
        const mediaParam = Number(searchParams.get('media'));
        // Browser history is the source of truth for the active reel and media index.
        setSelectedMediaIndex(Number.isInteger(mediaParam) && mediaParam >= 0 ? mediaParam : 0);

        if (!postParam) {
            directPostRequestRef.current = null;
            reelHistoryModeRef.current = null;
            setSelectedItemId(null);
            setDirectPostStatus(null);
            return;
        }

        if (reelHistoryModeRef.current === null) {
            reelHistoryModeRef.current = 'direct';
        }

        if (items.some((item) => item.id === postParam)) {
            directPostRequestRef.current = postParam;
            setSelectedItemId(postParam);
            setDirectPostStatus(null);
            return;
        }

        if (directPostRequestRef.current === postParam) {
            return;
        }

        directPostRequestRef.current = postParam;
        setSelectedItemId(postParam);
        setDirectPostStatus('loading');
        const controller = new AbortController();
        let settled = false;

        void fetch(`/api/showcase/posts/${encodeURIComponent(postParam)}`, {
            headers: session?.access_token
                ? {
                    Authorization: `Bearer ${session.access_token}`,
                }
                : undefined,
            signal: controller.signal,
        })
            .then(async (response) => {
                const payload = await response.json().catch(() => null);
                // Cut short while the body was still on its way: `json()`
                // rejected with the abort, which is no broken answer. The
                // cleanup that aborted it lets the next run ask again.
                if (controller.signal.aborted) {
                    return;
                }
                settled = true;
                if (!response.ok || !payload?.item) {
                    // 404 is the server's answer for a post that is gone or
                    // hidden from this viewer; any other failure may be brief.
                    setDirectPostStatus(response.status === 404 ? 'unavailable' : 'failed');
                    return;
                }

                const sharedItem = payload.item as ShowcaseFeedItem;
                setItems((currentItems) => currentItems.some((item) => item.id === sharedItem.id)
                    ? currentItems
                    : [...currentItems, sharedItem]);
                setSelectedItemId(sharedItem.id);
                setDirectPostStatus(null);
            })
            .catch((error) => {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    return;
                }

                settled = true;
                console.error('Failed to load shared showcase post:', error);
                setDirectPostStatus('failed');
            });

        return () => {
            controller.abort();
            // A read cut short by a re-run is asked again, not left loading.
            if (!settled && directPostRequestRef.current === postParam) {
                directPostRequestRef.current = null;
            }
        };
    }, [directPostAttempt, items, searchParams, session?.access_token, setItems]);

    const retryDirectPost = useCallback(() => {
        directPostRequestRef.current = null;
        setDirectPostAttempt((attempt) => attempt + 1);
    }, []);

    const updateReelUrl = useCallback((
        postId: string | null,
        mode: 'push' | 'replace',
        mediaIndex = 0
    ) => {
        const params = new URLSearchParams(window.location.search);
        if (postId) {
            params.set('post', postId);
            if (mediaIndex > 0) {
                params.set('media', String(mediaIndex));
            } else {
                params.delete('media');
            }
        } else {
            params.delete('post');
            params.delete('media');
        }

        const nextUrl = params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
        if (mode === 'push') {
            window.history.pushState(null, '', nextUrl);
        } else {
            window.history.replaceState(null, '', nextUrl);
        }
    }, [pathname]);

    const selectPreviewItem = useCallback((id: string) => {
        setSelectedMediaIndex(0);
        updateReelUrl(id, 'replace', 0);
        setSelectedItemId(id);
    }, [updateReelUrl]);

    // What the tiles call is kept across renders (`ShowcaseGridCard`), and
    // reads the list and the open post through refs, not from one render.
    const openPreview = useCallback((item: ShowcaseFeedItem, mediaIndex = 0) => {
        closingPostIdRef.current = null;
        reelHistoryModeRef.current = 'pushed';
        setSelectedMediaIndex(mediaIndex);
        updateReelUrl(item.id, 'push', mediaIndex);
        setSelectedItemId(item.id);
    }, [updateReelUrl]);

    const closePreview = useCallback(() => {
        closingPostIdRef.current = new URLSearchParams(window.location.search).get('post');
        setSelectedItemId(null);
        setDirectPostStatus(null);

        if (reelHistoryModeRef.current === 'pushed') {
            reelHistoryModeRef.current = null;
            window.history.back();
            return;
        }

        reelHistoryModeRef.current = null;
        updateReelUrl(null, 'replace');
    }, [updateReelUrl]);

    // The save hook returns a new toggleSave on every render; the tiles get
    // one function that reads the latest through a ref, as Home's cards do.
    const toggleSaveRef = useRef(toggleSave);
    toggleSaveRef.current = toggleSave;
    const handleToggleSave = useCallback((id: string) => {
        void toggleSaveRef.current(id);
    }, []);

    useEffect(() => {
        const handlePopState = () => {
            const postParam = new URLSearchParams(window.location.search).get('post');
            const mediaParam = Number(new URLSearchParams(window.location.search).get('media'));
            reelHistoryModeRef.current = postParam ? 'direct' : null;
            setSelectedMediaIndex(Number.isInteger(mediaParam) && mediaParam >= 0 ? mediaParam : 0);

            if (!postParam) {
                setSelectedItemId(null);
                setDirectPostStatus(null);
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    useEffect(() => {
        const previousSnapshot = initialSnapshotRef.current;
        const laneIsUnchanged = previousSnapshot.initialCategory === initialCategory
            && previousSnapshot.initialSort === initialSort
            && previousSnapshot.initialTool === initialTool
            && previousSnapshot.initialUnlock === initialUnlock
            && previousSnapshot.initialResource === initialResource;
        const snapshotIsUnchanged = previousSnapshot.initialFeed === initialFeed
            && laneIsUnchanged
            && previousSnapshot.userId === userId;
        initialSnapshotRef.current = {
            initialFeed,
            initialCategory,
            initialSort,
            initialTool,
            initialUnlock,
            initialResource,
            userId,
        };
        if (snapshotIsUnchanged) {
            return;
        }

        const visibleInitialItems = filterSessionHiddenItems(
            initialFeed.items,
            sessionHiddenPostIdsRef.current,
            sessionHiddenCreatorIdsRef.current
        );
        // A server navigation replaces the feed snapshot and its pagination/filter state.
        setItems(visibleInitialItems);
        setPageInfo(initialFeed.pageInfo);
        setRenderedItemCount(Math.min(SHOWCASE_INITIAL_RENDER_COUNT, visibleInitialItems.length));
        setFeedSessionId(getShowcaseFeedSessionId(initialFeed));
        setLaneFetchedAt(Date.now());
        // Another page: a removal still offering Undo stands.
        setTileRemoval(null);
        setIsLoadingMore(false);
        setLoadMoreError(null);
        setIsRefreshingLane(false);
        isLoadingMoreRef.current = false;
        loadMoreGenerationRef.current += 1;
        anonymousPersonalizationStartedRef.current = false;
        personalizedRefreshLandedRef.current = false;
        setCategory(initialCategory);
        setSort(initialSort);
        setTool(initialTool ?? 'all');
        setUnlock(initialUnlock);
        setResource(initialResource);
        setSavedItemIds(new Set(visibleInitialItems.filter((item) => item.isSaved).map((item) => item.id)));
        if (!laneIsUnchanged) {
            // Another lane is another feed, so it opens at its first row, as
            // the app's does. The filter bar stays on screen deep in the grid,
            // and a lane changed from there opened at the bottom of the new,
            // shorter page. A new viewer keeps their place.
            window.scrollTo({ top: 0 });
        }
    }, [initialCategory, initialFeed, initialResource, initialSort, initialTool, initialUnlock, setItems, setSavedItemIds, userId]);

    useEffect(() => {
        if (!hasDeferredItems || isLoadingInitialFeed) {
            return;
        }

        // Fill the grid on a short cadence instead of waiting on scroll
        // boundaries: the priority card owns the first paint, then every tick
        // mounts one more responsive row until nothing is deferred. The effect
        // re-runs (and the chain stops) when hasDeferredItems flips false.
        let tickHandle: number | null = null;

        const revealNextItems = () => {
            tickHandle = null;
            const batchSize = getShowcaseDeferredRevealBatchSize();
            startTransition(() => {
                setRenderedItemCount((currentCount) => Math.min(
                    currentCount + batchSize,
                    items.length
                ));
            });
            tickHandle = window.setTimeout(revealNextItems, SHOWCASE_DEFERRED_REVEAL_TICK_MS);
        };

        tickHandle = window.setTimeout(revealNextItems, SHOWCASE_DEFERRED_REVEAL_TICK_MS);

        return () => {
            if (tickHandle !== null) {
                window.clearTimeout(tickHandle);
            }
        };
    }, [hasDeferredItems, isLoadingInitialFeed, items.length]);

    useEffect(() => {
        if (
            isAuthLoading
            || hasAuthenticatedSession
            || user
            || hasAnonymousPersonalizationDemand
            || anonymousPersonalizationStartedRef.current
        ) {
            return;
        }

        const markDemand = () => setHasAnonymousPersonalizationDemand(true);
        window.addEventListener('pointerdown', markDemand, { passive: true, once: true });
        window.addEventListener('keydown', markDemand, { once: true });
        window.addEventListener('scroll', markDemand, { passive: true, once: true });
        window.addEventListener('showcase:demand', markDemand, { once: true });

        return () => {
            window.removeEventListener('pointerdown', markDemand);
            window.removeEventListener('keydown', markDemand);
            window.removeEventListener('scroll', markDemand);
            window.removeEventListener('showcase:demand', markDemand);
        };
    }, [
        hasAnonymousPersonalizationDemand,
        hasAuthenticatedSession,
        isAuthLoading,
        user,
    ]);

    useEffect(() => {
        if (isAuthLoading || sort !== DEFAULT_SHOWCASE_SORT) {
            return;
        }

        if (!hasAuthenticatedSession && !hasAnonymousPersonalizationDemand) {
            return;
        }

        // A filter click changes the local lane first and the server page
        // follows by navigation; refreshing on both fetched every lane twice.
        // Wait for the props to agree with the lane.
        if (
            category !== initialCategory
            || sort !== initialSort
            || tool !== (initialTool ?? 'all')
            || unlock !== initialUnlock
            || resource !== initialResource
        ) {
            return;
        }

        if (
            (userId && !hasAuthenticatedSession)
            || (!hasAuthenticatedSession && anonymousPersonalizationStartedRef.current)
        ) {
            return;
        }

        const controller = new AbortController();
        let retryHandle: number | null = null;
        const params = new URLSearchParams({
            limit: String(SHOWCASE_PAGE_SIZE),
        });
        setNonDefaultParam(params, 'category', requestCategoryFor(category), 'all');
        setNonDefaultParam(params, 'tool', tool, 'all');
        setNonDefaultParam(params, 'unlock', unlock, 'all');
        setNonDefaultParam(params, 'resource', resource, 'all');

        const refreshPersonalizedFeed = (retryCount = 0) => {
            const token = accessTokenRef.current;
            void fetch(`/api/showcase/feed?${params.toString()}`, {
                headers: token
                    ? { Authorization: `Bearer ${token}` }
                    : undefined,
                signal: controller.signal,
            })
                .then(async (response) => {
                    if (!response.ok) {
                        throw new Error(`Personalized feed request failed with ${response.status}`);
                    }

                    return response.json() as Promise<ShowcaseFeedPage>;
                })
                .then((personalizedFeed) => {
                    if (controller.signal.aborted) {
                        return;
                    }

                    personalizedRefreshPendingRef.current = false;
                    personalizedRefreshLandedRef.current = true;
                    const visiblePersonalizedItems = filterSessionHiddenItems(
                        personalizedFeed.items,
                        sessionHiddenPostIdsRef.current,
                        sessionHiddenCreatorIdsRef.current
                    );
                    // What has been taken off the page since it was drawn stays
                    // off: the answer about the first page (above) can land a
                    // moment before this one, and the list read here is from
                    // before it. Keeping the rows already drawn would put a
                    // blocked creator's posts straight back.
                    const currentItems = feedItemsForEventsRef.current.filter((candidate) => (
                        candidate.id === selectedItemIdRef.current
                        || !isSessionHiddenItem(candidate, sessionHiddenPostIdsRef.current, sessionHiddenCreatorIdsRef.current)
                    ));
                    const preservedVisibleItemCount = Math.min(
                        renderedItemCountRef.current,
                        currentItems.length
                    );
                    const selectedItem = selectedItemIdRef.current
                        ? currentItems.find((candidate) => candidate.id === selectedItemIdRef.current) ?? null
                        : null;
                    const incomingItems = selectedItem && !visiblePersonalizedItems.some((candidate) => candidate.id === selectedItem.id)
                        ? [...visiblePersonalizedItems, selectedItem]
                        : visiblePersonalizedItems;
                    const nextItems = mergeShowcaseFeedKeepingVisibleItems(
                        currentItems,
                        incomingItems,
                        preservedVisibleItemCount
                    );
                    const preservedItemIds = new Set(
                        currentItems
                            .slice(0, preservedVisibleItemCount)
                            .map((item) => item.id)
                    );
                    if (selectedItem) {
                        preservedItemIds.add(selectedItem.id);
                    }
                    setItems(nextItems);
                    setRenderedItemCount((currentCount) => Math.min(
                        Math.max(SHOWCASE_INITIAL_RENDER_COUNT, currentCount),
                        nextItems.length
                    ));
                    setPageInfo(personalizedFeed.pageInfo);
                    setFeedSessionId(getShowcaseFeedSessionId(personalizedFeed));
                    setLaneFetchedAt(Date.now());
                    setSavedItemIds((currentSavedItemIds) => {
                        const nextSavedItemIds = new Set(
                            visiblePersonalizedItems.filter((item) => item.isSaved).map((item) => item.id)
                        );
                        preservedItemIds.forEach((itemId) => {
                            if (currentSavedItemIds.has(itemId)) {
                                nextSavedItemIds.add(itemId);
                            }
                        });
                        return nextSavedItemIds;
                    });
                    setLoadMoreError(null);
                    isLoadingMoreRef.current = false;
                    setIsLoadingMore(false);
                })
                .catch((error) => {
                    if (controller.signal.aborted) {
                        return;
                    }

                    if (retryCount < SHOWCASE_REFRESH_MAX_RETRIES) {
                        retryHandle = window.setTimeout(() => {
                            retryHandle = null;
                            refreshPersonalizedFeed(retryCount + 1);
                        }, SHOWCASE_REFRESH_RETRY_BASE_MS * (2 ** retryCount));
                        return;
                    }

                    // A later navigation/filter change may establish a fresh
                    // session after all bounded attempts have been exhausted,
                    // and so may Load More or Retry (`loadMore`).
                    personalizedRefreshPendingRef.current = false;
                    anonymousPersonalizationStartedRef.current = false;
                    console.error('Failed to refresh personalized showcase feed:', error);
                    // A first page with more posts and no cursor goes on only
                    // through the viewer's own feed: without this its Load More
                    // did nothing, and nothing said why.
                    if (pageInfoRef.current.hasMore && !pageInfoRef.current.nextCursor) {
                        setLoadMoreError('Could not load more posts. Your current feed is still available.');
                        isLoadingMoreRef.current = false;
                        setIsLoadingMore(false);
                    }
                });
        };
        personalizedRefreshPendingRef.current = true;
        // Signed-in viewers should see their ranking immediately. Anonymous
        // viewers already have a useful server bootstrap, so establish their
        // feed session only after real demand and an idle browser window.
        const cancelScheduledRefresh = hasAuthenticatedSession
            ? (refreshPersonalizedFeed(), null)
            : scheduleIdleWork(() => {
                anonymousPersonalizationStartedRef.current = true;
                refreshPersonalizedFeed();
            }, SHOWCASE_ANONYMOUS_REFRESH_IDLE_TIMEOUT_MS);

        return () => {
            cancelScheduledRefresh?.();
            if (retryHandle !== null) {
                window.clearTimeout(retryHandle);
            }
            controller.abort();
            personalizedRefreshPendingRef.current = false;
        };
    }, [
        category,
        hasAnonymousPersonalizationDemand,
        hasAuthenticatedSession,
        initialCategory,
        initialFeed,
        initialResource,
        initialSort,
        initialTool,
        initialUnlock,
        isAuthLoading,
        personalizedRefreshRequest,
        resource,
        setItems,
        setSavedItemIds,
        sort,
        tool,
        unlock,
        userId,
    ]);

    useEffect(() => {
        if (feedbackNotice?.tone !== 'success') {
            return;
        }

        const timeout = window.setTimeout(() => setFeedbackNotice(null), 4500);
        return () => window.clearTimeout(timeout);
    }, [feedbackNotice]);

    const navigateWithFilters = (
        nextCategory: ShowcaseCategory,
        nextSort: ShowcaseSort,
        nextTool = tool,
        nextUnlock = unlock,
        nextResource = resource
    ) => {
        startLaneTransition(() => {
            router.replace(buildShowcaseLanePath(pathname, {
                category: nextCategory,
                sort: nextSort,
                tool: nextTool,
                unlock: nextUnlock,
                resource: nextResource,
            }), {
                scroll: false,
            });
        });
    };

    // A thread read in the reel reports the post's comment count; the grid's
    // copy follows it, so the reel opened on that post again says the same.
    const updateCommentCount = useCallback((postId: string, commentCount: number) => {
        setItems((currentItems) => {
            const index = currentItems.findIndex((candidate) => candidate.id === postId);
            if (index < 0 || currentItems[index].commentCount === commentCount) return currentItems;
            const nextItems = currentItems.slice();
            nextItems[index] = { ...currentItems[index], commentCount };
            return nextItems;
        });
    }, [setItems]);

    const loadMore = useCallback(async () => {
        const nextCursor = sort === DEFAULT_SHOWCASE_SORT ? pageInfo.nextCursor ?? null : null;
        const nextOffset = pageInfo.nextOffset;
        if (isLoadingMoreRef.current || !pageInfo.hasMore) {
            return;
        }

        // For you's first page is built for everyone and has no cursor: what
        // follows it is the viewer's own feed, merged in under the drawn rows
        // (the refresh effect above). Asking for more asks for that: it is the
        // demand a guest's feed waits on, and it starts the refresh again after
        // it gave up. Loading shows until the page comes, or the Retry row.
        // Once it has come, a page still without a cursor goes on by offset.
        if (sort === DEFAULT_SHOWCASE_SORT && !nextCursor && !personalizedRefreshLandedRef.current) {
            isLoadingMoreRef.current = true;
            setIsLoadingMore(true);
            setLoadMoreError(null);
            setHasAnonymousPersonalizationDemand(true);
            if (!personalizedRefreshPendingRef.current) {
                setPersonalizedRefreshRequest((request) => request + 1);
            }
            return;
        }

        if (!nextCursor && nextOffset === null) {
            return;
        }

        isLoadingMoreRef.current = true;
        setIsLoadingMore(true);
        setLoadMoreError(null);
        const loadMoreGeneration = loadMoreGenerationRef.current;

        try {
            const params = new URLSearchParams({ limit: String(SHOWCASE_PAGE_SIZE) });
            if (sort === DEFAULT_SHOWCASE_SORT && nextCursor) {
                params.set('cursor', nextCursor);
            } else if (nextOffset !== null) {
                params.set('offset', String(nextOffset));
            }
            setNonDefaultParam(params, 'category', requestCategoryFor(category), 'all');
            setNonDefaultParam(params, 'sort', sort, DEFAULT_SHOWCASE_SORT);
            setNonDefaultParam(params, 'tool', tool, 'all');
            setNonDefaultParam(params, 'unlock', unlock, 'all');
            setNonDefaultParam(params, 'resource', resource, 'all');

            const response = await fetch(`/api/showcase/feed?${params.toString()}`, accessToken ? {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            } : undefined);
            if (!response.ok) {
                throw new Error(`Feed request failed with ${response.status}`);
            }

            const nextFeed: ShowcaseFeedPage = await response.json();
            // The lane changed while this page was in flight: a server
            // navigation reset the feed, and this page belongs to the old one.
            if (loadMoreGeneration !== loadMoreGenerationRef.current) {
                return;
            }
            const visibleNextItems = filterSessionHiddenItems(
                nextFeed.items,
                sessionHiddenPostIdsRef.current,
                sessionHiddenCreatorIdsRef.current
            );

            setItems((currentItems) => [
                ...currentItems,
                ...visibleNextItems.filter((item) => !currentItems.some((current) => current.id === item.id)),
            ]);
            setPageInfo(nextFeed.pageInfo);
            const nextFeedSessionId = getShowcaseFeedSessionId(nextFeed);
            if (nextFeedSessionId) {
                setFeedSessionId(nextFeedSessionId);
            }
            setSavedItemIds((currentSavedIds) => {
                const nextSavedIds = new Set(currentSavedIds);
                visibleNextItems.forEach((item) => {
                    if (item.isSaved) {
                        nextSavedIds.add(item.id);
                    }
                });
                return nextSavedIds;
            });
        } catch (error) {
            if (loadMoreGeneration !== loadMoreGenerationRef.current) return;
            console.error('Failed to fetch more showcase items:', error);
            setLoadMoreError('Could not load more posts. Your current feed is still available.');
        } finally {
            // A stale page's end must not clear the new lane's own in-flight load.
            if (loadMoreGeneration === loadMoreGenerationRef.current) {
                isLoadingMoreRef.current = false;
                setIsLoadingMore(false);
            }
        }
    }, [
        accessToken,
        category,
        pageInfo.hasMore,
        pageInfo.nextCursor,
        pageInfo.nextOffset,
        resource,
        setItems,
        setSavedItemIds,
        sort,
        tool,
        unlock,
    ]);

    useEffect(() => {
        const sentinel = loadMoreSentinelRef.current;
        if (!sentinel || !pageInfo.hasMore || isLoadingInitialFeed || hasDeferredItems) {
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                void loadMore();
            }
        }, {
            rootMargin: '400px 0px',
        });

        observer.observe(sentinel);

        return () => {
            observer.disconnect();
        };
    }, [hasDeferredItems, isLoadingInitialFeed, loadMore, pageInfo.hasMore]);

    // The end of a lane offers Refresh, as the app's pull and header button
    // do: page one asked for afresh replaces the grid. What was kept of the
    // lane for coming back to it goes first, or a back navigation would bring
    // the old grid back.
    const refreshLane = async () => {
        if (isLoadingMoreRef.current || personalizedRefreshPendingRef.current) {
            return;
        }

        forgetShowcaseClientSnapshot(showcaseClientCacheKey);
        pendingSnapshotRef.current = null;
        isLoadingMoreRef.current = true;
        setIsRefreshingLane(true);
        setLoadMoreError(null);
        // The grid is drawn afresh: a removal still offering Undo stands.
        setTileRemoval(null);
        // This page one is the viewer's own: For you's refresh, which a
        // guest's first interaction (this tap) starts, need not ask again.
        anonymousPersonalizationStartedRef.current = true;
        const refreshGeneration = loadMoreGenerationRef.current;

        try {
            const params = new URLSearchParams({ limit: String(SHOWCASE_PAGE_SIZE) });
            setNonDefaultParam(params, 'category', requestCategoryFor(category), 'all');
            setNonDefaultParam(params, 'sort', sort, DEFAULT_SHOWCASE_SORT);
            setNonDefaultParam(params, 'tool', tool, 'all');
            setNonDefaultParam(params, 'unlock', unlock, 'all');
            setNonDefaultParam(params, 'resource', resource, 'all');

            const response = await fetch(`/api/showcase/feed?${params.toString()}`, accessToken ? {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            } : undefined);
            if (!response.ok) {
                throw new Error(`Feed request failed with ${response.status}`);
            }

            const firstPage: ShowcaseFeedPage = await response.json();
            // A lane change while this was in flight: the page is the old lane's.
            if (refreshGeneration !== loadMoreGenerationRef.current) {
                return;
            }
            const visibleItems = filterSessionHiddenItems(
                firstPage.items,
                sessionHiddenPostIdsRef.current,
                sessionHiddenCreatorIdsRef.current
            );
            personalizedRefreshLandedRef.current = true;
            setItems(visibleItems);
            setPageInfo(firstPage.pageInfo);
            setFeedSessionId(getShowcaseFeedSessionId(firstPage));
            setLaneFetchedAt(Date.now());
            setRenderedItemCount(Math.min(SHOWCASE_INITIAL_RENDER_COUNT, visibleItems.length));
            setSavedItemIds(new Set(visibleItems.filter((item) => item.isSaved).map((item) => item.id)));
            // The reader was at the end of the old grid; the new one starts at the top.
            window.scrollTo({ top: 0 });
        } catch (error) {
            if (refreshGeneration !== loadMoreGenerationRef.current) {
                return;
            }
            anonymousPersonalizationStartedRef.current = false;
            console.error('Failed to refresh the showcase lane:', error);
            setFeedbackNotice({
                tone: 'error',
                message: 'Could not refresh Explore. Your current feed is still available.',
            });
        } finally {
            if (refreshGeneration === loadMoreGenerationRef.current) {
                isLoadingMoreRef.current = false;
                setIsRefreshingLane(false);
            }
        }
    };

    const handleRemix = async (
        id: string,
        sourceSurface: ShowcaseEventSourceSurface = 'showcase'
    ) => {
        if (!user || !session?.access_token) {
            // Deep in the reel the bare '/showcase' fallback costs the viewer the
            // post and their scroll position, so return to wherever they are.
            router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath('/showcase'))}`);
            return;
        }

        try {
            const { redirectTo } = await requestShowcaseRemix({
                accessToken: session.access_token,
                generationId: id,
            });

            const remixedItem = feedItemsForEventsRef.current.find((candidate) => candidate.id === id);
            if (remixedItem) {
                void sendShowcaseFeedEvent({
                    item: remixedItem,
                    eventType: 'remix_start',
                    sourceSurface,
                    accessToken: session.access_token,
                    feedSessionId: feedSessionIdForEventsRef.current,
                    fallbackPosition: feedItemsForEventsRef.current.findIndex(
                        (candidate) => candidate.id === id
                    ),
                    metadata: {
                        redirectTo,
                    },
                }).catch(() => undefined);
            }
            router.push(redirectTo);
        } catch (error) {
            console.error('Remix failed:', error);
            // Rethrow so the reel viewer surfaces the reason instead of the
            // tap silently doing nothing.
            throw error;
        }
    };

    const handleFeedFeedback = useCallback(async (
        feedbackItem: ShowcaseFeedItem,
        action: ShowcaseFeedbackAction,
        sourceSurface: ShowcaseEventSourceSurface
    ) => {
        if (
            action === 'hide_creator'
            && (!feedbackItem.creator.id || feedbackItem.creator.id === userId)
        ) {
            return;
        }

        const currentItems = feedItemsForEventsRef.current;
        const openItemId = selectedItemIdRef.current;
        const itemPosition = currentItems.findIndex((candidate) => candidate.id === feedbackItem.id);
        const removedItems = currentItems
            .map((candidate, index) => ({ item: candidate, index }))
            .filter(({ item: candidate }) => action === 'hide_creator'
                ? candidate.creator.id === feedbackItem.creator.id
                : candidate.id === feedbackItem.id);

        if (removedItems.length === 0) {
            return;
        }

        if (!userId) {
            if (action === 'hide_creator' && feedbackItem.creator.id) {
                sessionHiddenCreatorIdsRef.current.add(feedbackItem.creator.id);
            } else {
                sessionHiddenPostIdsRef.current.add(feedbackItem.id);
            }
        }

        const removedIds = new Set(removedItems.map(({ item: candidate }) => candidate.id));
        setFeedbackNotice(null);
        // Taken from the list as it is when this lands: the refs follow each
        // commit a moment later, and a page appended in that moment stays.
        setItems((latestItems) => latestItems.filter((candidate) => !removedIds.has(candidate.id)));

        if (openItemId && removedIds.has(openItemId)) {
            const replacementItem = pickReelReplacement(
                currentItems,
                currentItems.findIndex((candidate) => candidate.id === openItemId),
                (candidate) => removedIds.has(candidate.id)
            );

            if (replacementItem) {
                selectPreviewItem(replacementItem.id);
            } else {
                closePreview();
            }
        }

        const hideRequest = sendShowcaseFeedEvent({
            item: feedbackItem,
            eventType: action,
            sourceSurface,
            accessToken: accessTokenRef.current,
            feedSessionId: feedSessionIdForEventsRef.current,
            fallbackPosition: itemPosition >= 0 ? itemPosition : undefined,
            metadata: {
                creatorId: feedbackItem.creator.id,
            },
        }).then(() => true, (error: unknown) => {
            console.error('Failed to save showcase feedback:', error);
            return false;
        });
        // The tile's cell offers Undo (D7), among the tiles left: a hidden
        // creator's tiles before it go too. The reel moves on to the next post
        // and has no cell to offer it in.
        const removal: FeedRemoval<ShowcaseFeedItem> | null = sourceSurface === 'showcase' ? {
            id: ++removalIdRef.current,
            postId: feedbackItem.id,
            label: feedRemovalLabel(action, feedbackItem.creator.name),
            target: action === 'hide_creator' && feedbackItem.creator.id
                ? { feedbackType: 'hide_creator', creatorId: feedbackItem.creator.id }
                : { feedbackType: 'not_interested', postId: feedbackItem.id },
            removed: removedItems,
            rowIndex: currentItems
                .slice(0, Math.max(itemPosition, 0))
                .filter((candidate) => !removedIds.has(candidate.id) && !isTextOnlyPost(candidate))
                .length,
            hideRequest,
        } : null;
        if (removal) {
            setTileRemoval(removal);
        }
        const isUndone = () => Boolean(removal && undoneRemovalIdsRef.current.has(removal.id));

        if (await hideRequest) {
            if (isUndone()) {
                return;
            }
            setFeedbackNotice({
                tone: 'success',
                message: !userId
                    ? action === 'hide_creator'
                        ? `Posts from ${feedbackItem.creator.name} are hidden for this visit.`
                        : 'Post removed for this visit.'
                    : action === 'hide_creator'
                        ? `Posts from ${feedbackItem.creator.name} are now hidden.`
                        : 'Thanks. We’ll show you fewer posts like that.',
            });
            return;
        }
        // Taken back already: the tiles are in the grid and nothing was stored.
        if (isUndone()) {
            return;
        }

        if (!userId) {
            if (action === 'hide_creator' && feedbackItem.creator.id) {
                sessionHiddenCreatorIdsRef.current.delete(feedbackItem.creator.id);
            } else {
                sessionHiddenPostIdsRef.current.delete(feedbackItem.id);
            }
        }
        if (removal) {
            setTileRemoval((current) => (current?.id === removal.id ? null : current));
        }
        setItems((latestItems) => putBackRemovedFeedItems(latestItems, removedItems));
        setFeedbackNotice({
            tone: 'error',
            message: 'We couldn’t save that preference, so the post was restored. Please try again.',
        });
    }, [closePreview, selectPreviewItem, setItems, userId]);
    // Undo: the tiles go back to their cells and this visit forgets the
    // removal, in this grid and in what the tab remembers. A signed-in
    // viewer's preference is deleted on the server once the hide it takes back
    // has settled; a guest's lived on this page alone, and nothing is sent.
    const undoTileRemoval = useCallback((removal: FeedRemoval<ShowcaseFeedItem>) => {
        undoneRemovalIdsRef.current.add(removal.id);
        setTileRemoval((current) => (current?.id === removal.id ? null : current));
        // "Fewer posts like that" no longer holds.
        setFeedbackNotice(null);
        if (removal.target.feedbackType === 'hide_creator') {
            sessionHiddenCreatorIdsRef.current.delete(removal.target.creatorId);
        } else {
            sessionHiddenPostIdsRef.current.delete(removal.target.postId);
        }
        forgetFeedPreferenceForVisit(userId, removal.target);
        setItems((latestItems) => putBackRemovedFeedItems(latestItems, removal.removed));
        const token = accessTokenRef.current;
        if (!userId || !token || !removal.hideRequest) {
            return;
        }
        void undoShowcaseFeedFeedbackAfterHide({
            hideRequest: removal.hideRequest,
            accessToken: token,
            target: removal.target,
        }).then((undone) => {
            // The tile stays; the server will leave it out next time.
            if (!undone) {
                setFeedbackNotice({ tone: 'error', message: FEED_UNDO_FAILED_MESSAGE });
            }
        });
    }, [setItems, userId]);
    useEffect(() => {
        if (!tileRemoval) {
            return;
        }
        const timeout = window.setTimeout(() => {
            setTileRemoval((current) => (current?.id === tileRemoval.id ? null : current));
        }, FEED_REMOVAL_UNDO_MS);
        return () => window.clearTimeout(timeout);
    }, [tileRemoval]);

    // Report content, Report user and Block user, asked for and sent as the
    // feed card's are (`lib/feed-safety-actions.ts`). The server takes them
    // from registered accounts only, so a signed-out viewer is asked to sign
    // in first, and comes back here.
    const requireAccount = useCallback((): string | null => {
        if (userId && accessTokenRef.current) return accessTokenRef.current;
        router.push(`/login?returnUrl=${encodeURIComponent(getCurrentInternalPath('/showcase'))}`);
        return null;
    }, [router, userId]);
    const clearFeedbackNotice = useCallback(() => setFeedbackNotice(null), []);
    const showSafetyOutcome = useCallback((outcome: FeedSafetyOutcome) => {
        if (outcome.status === 'cancelled') return;
        setFeedbackNotice({ tone: outcome.status === 'done' ? 'success' : 'error', message: outcome.message });
    }, []);
    // Takes posts out of the grid once a report or a block has gone through.
    // The answer can arrive after the grid has grown or the reel has moved on,
    // so it reads both as they are now. A reel left open on a removed post
    // moves to the post that followed it, or the one before, or closes.
    const removeAfterSafetyAction = useCallback((isRemoved: (candidate: ShowcaseFeedItem) => boolean) => {
        const currentItems = feedItemsForEventsRef.current;
        const openId = selectedItemIdRef.current;
        const openPosition = openId ? currentItems.findIndex((candidate) => candidate.id === openId) : -1;
        setItems((latestItems) => latestItems.filter((candidate) => !isRemoved(candidate)));
        if (openPosition < 0 || !isRemoved(currentItems[openPosition])) return;
        const replacementItem = pickReelReplacement(currentItems, openPosition, isRemoved);
        if (replacementItem) {
            selectPreviewItem(replacementItem.id);
        } else {
            closePreview();
        }
    }, [closePreview, selectPreviewItem, setItems]);
    const handleReportContent = useCallback(async (reportedItem: ShowcaseFeedItem, surface: 'explore' | 'reel') => {
        const token = requireAccount();
        if (!token) return;
        const outcome = await reportPostAfterConfirmation({
            postId: reportedItem.id,
            accessToken: token,
            surface,
            onSend: clearFeedbackNotice,
            // The tile's or the reel's delivery, so the ranker hears the report.
            deliveryId: reportedItem.recommendation?.deliveryId,
        });
        if (outcome.status === 'done') {
            sessionHiddenPostIdsRef.current.add(reportedItem.id);
            removeAfterSafetyAction((candidate) => candidate.id === reportedItem.id);
        }
        showSafetyOutcome(outcome);
    }, [clearFeedbackNotice, removeAfterSafetyAction, requireAccount, showSafetyOutcome]);
    const handleReportUser = useCallback(async (reportedItem: ShowcaseFeedItem, surface: 'explore' | 'reel') => {
        const creatorId = reportedItem.creator.id;
        if (!creatorId || creatorId === userId) return;
        const token = requireAccount();
        if (!token) return;
        showSafetyOutcome(await reportCreatorAfterConfirmation({
            userId: creatorId,
            accessToken: token,
            surface,
            onSend: clearFeedbackNotice,
        }));
    }, [clearFeedbackNotice, requireAccount, showSafetyOutcome, userId]);
    const handleBlockUser = useCallback(async (blockedItem: ShowcaseFeedItem) => {
        const creatorId = blockedItem.creator.id;
        if (!creatorId || creatorId === userId) return;
        const token = requireAccount();
        if (!token) return;
        const outcome = await blockCreatorAfterConfirmation({
            userId: creatorId,
            creatorName: blockedItem.creator.name,
            accessToken: token,
            onSend: clearFeedbackNotice,
        });
        if (outcome.status === 'done') {
            sessionHiddenCreatorIdsRef.current.add(creatorId);
            removeAfterSafetyAction((candidate) => candidate.creator.id === creatorId);
        }
        showSafetyOutcome(outcome);
    }, [clearFeedbackNotice, removeAfterSafetyAction, requireAccount, showSafetyOutcome, userId]);

    // "New posts" (D2): For you only, Recent has its own order to come back to
    // and Saved, Remixed and Sales are not ordered by time; and only without a
    // tool, recipe or kind filter, which the probe cannot name. The lane is the
    // one the grid holds: the controls run ahead of it while a lane loads.
    const probeLane = useMemo<NewPostsProbeLane | null>(() => (
        initialSort === DEFAULT_SHOWCASE_SORT
        && (initialTool ?? 'all') === 'all'
        && initialUnlock === 'all'
        && initialResource === 'all'
            ? { key: showcaseClientCacheKey, category: feedNewestCategoryFor(requestCategoryFor(initialCategory)) }
            : null
    ), [initialCategory, initialResource, initialSort, initialTool, initialUnlock, showcaseClientCacheKey]);
    const newestKnownAt = useMemo(() => newestCreatedAtOf(items.filter((item) => !isTextOnlyPost(item))), [items]);
    const { hasNewer: hasNewerPosts, dismiss: dismissNewPosts } = useNewPostsProbe({
        lane: isPending || isLoadingInitialFeed || tileableItems.length === 0 ? null : probeLane,
        laneFetchedAt,
        newestKnownAt,
    });
    // The pill's tap is the lane's own Refresh: its first page afresh, from the top.
    const showNewPosts = () => {
        dismissNewPosts();
        if (window.scrollY > 0) {
            window.scrollTo({ top: 0, behavior: newPostsScrollBehavior() });
        }
        void refreshLane();
    };

    const activeFilterPills = [
        tool !== 'all' ? {
            key: 'tool',
            label: sourceToolOptions.find((option) => option.slug === tool)?.label ?? tool,
            clear: () => {
                setTool('all');
                navigateWithFilters(category, sort, 'all', unlock, resource);
            },
        } : null,
        unlock !== 'all' ? {
            key: 'unlock',
            label: UNLOCK_FILTERS.find((option) => option.id === unlock)?.label ?? unlock,
            clear: () => {
                setUnlock('all');
                navigateWithFilters(category, sort, tool, 'all', resource);
            },
        } : null,
        resource !== 'all' ? {
            key: 'resource',
            label: RESOURCE_FILTERS.find((option) => option.id === resource)?.label ?? resource,
            clear: () => {
                setResource('all');
                navigateWithFilters(category, sort, tool, unlock, 'all');
            },
        } : null,
    ].filter((pill): pill is { key: string; label: string; clear: () => void } => Boolean(pill));
    // Worded as the app's end of Explore: For you as it comes is all caught
    // up, and a narrower lane is named by its narrowest choice, the tool or
    // filter first as in the app, then the kind, then the sort.
    const narrowestLaneLabel = activeFilterPills[0]?.label
        ?? (category !== 'all' ? CATEGORIES.find((option) => option.id === category)?.label : undefined)
        ?? (sort !== DEFAULT_SHOWCASE_SORT ? SORTS.find((option) => option.id === sort)?.label : undefined);
    const endOfLaneMessage = narrowestLaneLabel
        ? `You've reached the end of ${narrowestLaneLabel}.`
        : "You're all caught up.";

    return (
        <div className="ui-page ui-page-ambient min-h-screen py-5 font-[family-name:var(--font-geist-sans)] sm:py-7">
            <div className="studio-shell relative z-10">
                <div className="ui-enter mb-7 flex flex-col gap-5 border-b border-[var(--ui-border-subtle)] pb-7 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <div className="mb-3 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)]">
                            <TrendingUp className="h-3.5 w-3.5" />
                            Creator community
                        </div>
                        <h1 className="text-4xl font-extrabold tracking-[-0.035em] text-[var(--ui-text-primary)] sm:text-5xl">
                            Explore
                        </h1>
                        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ui-text-muted)] sm:text-base">
                            Fresh creator posts with optional recipes. Browse the result, then save it, remix it, or open the reusable process.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Link
                            href="/post/new?from=community&returnTo=%2Fshowcase"
                            prefetch={false}
                            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
                        >
                            Share a post
                        </Link>
                        <Link
                            href="/marketplace"
                            prefetch={false}
                            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-amber-300/20 bg-amber-400/10 px-5 text-sm font-bold text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-400/15"
                        >
                            Browse recipes
                        </Link>
                    </div>
                </div>

                <div className="sticky top-[calc(var(--app-shell-topbar-height)+0.5rem)] z-30 mb-7 rounded-[28px] border border-[var(--ui-border-default)] bg-[rgba(25,25,28,0.92)] p-3 shadow-[0_12px_30px_rgba(0,0,0,0.24)] backdrop-blur-xl sm:p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="relative min-w-0 w-full sm:w-auto">
                      <div
                        className="flex gap-2 overflow-x-auto pb-1 pr-12 sm:pb-0 sm:pr-0 hide-scrollbar"
                        aria-label="Filter posts by media type"
                      >
                        {CATEGORIES.map((cat) => {
                            const Icon = cat.icon;
                            const isActive = category === cat.id;

                            return (
                                <button
                                    key={cat.id}
                                    type="button"
                                    onClick={() => {
                                        setCategory(cat.id);
                                        navigateWithFilters(cat.id, sort);
                                    }}
                                    disabled={isPending}
                                    aria-pressed={isActive}
                                    className={`ui-focus-ring flex min-h-12 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm font-bold transition disabled:opacity-70
                                        ${isActive
                                            ? 'border-[var(--ui-primary-strong)] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]'
                                            : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)]'
                                        }`}
                                >
                                    <Icon className="w-4 h-4" />
                                    {cat.label}
                                </button>
                            );
                        })}
                      </div>
                      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[rgba(25,25,28,0.98)] to-transparent sm:hidden" />
                    </div>
                    <div className="flex items-center gap-2">
                        <select
                            value={sort}
                            onChange={(event) => {
                                const nextSort = event.target.value as ShowcaseSort;
                                setSort(nextSort);
                                navigateWithFilters(category, nextSort);
                            }}
                            disabled={isPending}
                            className="ui-focus-ring h-12 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 text-sm font-bold text-[var(--ui-text-primary)] outline-none transition hover:border-[var(--ui-border-strong)] disabled:opacity-70"
                            aria-label="Sort community posts"
                        >
                            {SORTS.map((sortOption) => (
                                <option key={sortOption.id} value={sortOption.id}>
                                    {sortOption.label}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => setIsFilterPanelOpen((current) => !current)}
                            className={`ui-focus-ring inline-flex h-12 items-center gap-2 rounded-full border px-4 text-sm font-bold transition ${
                                isFilterPanelOpen || activeFilterPills.length > 0
                                    ? 'border-[rgba(255,122,89,0.32)] bg-[var(--ui-primary-soft)] text-[var(--ui-primary-strong)]'
                                    : 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-3)]'
                            }`}
                            aria-expanded={isFilterPanelOpen}
                            aria-controls="showcase-filter-panel"
                        >
                            <SlidersHorizontal className="h-4 w-4" />
                            Filters
                            {activeFilterPills.length > 0 ? (
                                <span className="rounded-full bg-white/15 px-1.5 py-0.5 text-[11px]">{activeFilterPills.length}</span>
                            ) : null}
                        </button>
                    </div>
                  </div>

                  {activeFilterPills.length > 0 ? (
                    <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                        {activeFilterPills.map((pill) => (
                            <button
                                key={pill.key}
                                type="button"
                                onClick={pill.clear}
                                className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/[0.08]"
                            >
                                {pill.label}
                                <X className="h-3.5 w-3.5" />
                            </button>
                        ))}
                    </div>
                  ) : null}

                  {isFilterPanelOpen ? (
                        <div id="showcase-filter-panel" className="overflow-hidden">
                            <div className="mt-4 grid gap-4 border-t border-white/8 pt-4 lg:grid-cols-3">
                                <div>
                                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Tool</div>
                                    <div className="flex gap-2 overflow-x-auto pb-1">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setTool('all');
                                                navigateWithFilters(category, sort, 'all');
                                            }}
                                            aria-pressed={tool === 'all'}
                                            className={`ui-focus-ring min-h-11 shrink-0 rounded-full border px-3 text-sm font-bold transition ${tool === 'all' ? 'border-sky-300/30 bg-sky-400/15 text-sky-50' : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]'}`}
                                        >
                                            All tools
                                        </button>
                                        {sourceToolOptions.map((option) => (
                                            <button
                                                key={option.slug}
                                                type="button"
                                                onClick={() => {
                                                    setTool(option.slug);
                                                    navigateWithFilters(category, sort, option.slug);
                                                }}
                                                aria-pressed={tool === option.slug}
                                                className={`ui-focus-ring min-h-11 shrink-0 rounded-full border px-3 text-sm font-bold transition ${tool === option.slug ? 'border-sky-300/30 bg-sky-400/15 text-sky-50' : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]'}`}
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Recipe</div>
                                    <div className="flex flex-wrap gap-2">
                                        {UNLOCK_FILTERS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => {
                                setUnlock(option.id);
                                navigateWithFilters(category, sort, tool, option.id, resource);
                            }}
                            aria-pressed={unlock === option.id}
                            className={`ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm font-bold transition ${unlock === option.id ? 'border-amber-300/30 bg-amber-400/15 text-amber-50' : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]'}`}
                        >
                            <BadgeDollarSign className="h-4 w-4" />
                            {option.label}
                        </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Kind</div>
                                    <div className="flex flex-wrap gap-2">
                                        {RESOURCE_FILTERS.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            onClick={() => {
                                setResource(option.id);
                                navigateWithFilters(category, sort, tool, unlock, option.id);
                            }}
                            aria-pressed={resource === option.id}
                            className={`ui-focus-ring min-h-11 rounded-full border px-3 text-sm font-bold transition ${resource === option.id ? 'border-[var(--ui-primary)]/35 bg-[var(--ui-primary-soft)] text-[var(--ui-primary-strong)]' : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]'}`}
                        >
                            {option.label}
                        </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                  ) : null}

                  {hasNewerPosts ? (
                    // Hangs under the filter bar, so it floats over the top
                    // of the grid and stays in view with the bar as the
                    // reader scrolls; takes no room.
                    <div className="pointer-events-none absolute inset-x-0 top-full flex justify-center pt-3">
                        <NewPostsPill onPress={showNewPosts} className="pointer-events-auto" />
                    </div>
                  ) : null}
                </div>

                {isLoadingInitialFeed ? (
                    <div className={SHOWCASE_FEED_GRID_CLASS}>
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((placeholder) => (
                            <div key={placeholder} className="min-w-0">
                                <SkeletonLoader className="h-64" />
                            </div>
                        ))}
                    </div>
                ) : tileableItems.length === 0 && !tileRemoval ? (
                    <div className="rounded-[28px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-6 py-16 text-center text-[var(--ui-text-muted)]">
                        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--ui-surface-2)] text-[var(--ui-text-faint)]">
                            <ImageIcon className="h-6 w-6" aria-hidden />
                        </span>
                        <p className="text-lg font-bold text-[var(--ui-text-primary)]">Nothing in this lane yet</p>
                        <p className="mt-2 text-sm">Clear a filter or share a result, tip, prompt, or workflow to start it.</p>
                        <Link href="/post/new?from=community&returnTo=%2Fshowcase" className="ui-focus-ring mt-5 inline-flex min-h-12 items-center rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)]">
                            Share the first post
                        </Link>
                    </div>
                ) : (
                    <div
                        className={SHOWCASE_FEED_GRID_CLASS}
                        onPointerEnter={warmShowcaseReelViewer}
                        onTouchStart={warmShowcaseReelViewer}
                    >
                            {withRemovalRow(renderedItems.map((item, itemIndex) => (
                                <ShowcaseGridCard
                                    key={item.id}
                                    item={item}
                                    index={itemIndex}
                                    isSaved={savedItemIds.has(item.id)}
                                    isPriority={item.id === priorityMediaItemId}
                                    priorityPoster={item.id === initialPriorityPoster?.postId ? initialPriorityPoster : null}
                                    feedSessionId={feedSessionId}
                                    accessToken={accessToken}
                                    viewerId={userId}
                                    returnTo={laneReturnPath}
                                    autoPlayVideo={item.id === playingTileId}
                                    observeVideoTile={observeVideoTile}
                                    onOpenPreview={openPreview}
                                    onToggleSave={handleToggleSave}
                                    onFeedback={handleFeedFeedback}
                                    onReportContent={handleReportContent}
                                    onReportUser={handleReportUser}
                                    onBlockUser={handleBlockUser}
                                />
                            )), tileRemoval?.rowIndex ?? null, tileRemoval ? (
                                <FeedRemovalUndoRow
                                    key={`removed:${tileRemoval.postId}`}
                                    label={tileRemoval.label}
                                    onUndo={() => undoTileRemoval(tileRemoval)}
                                    className="min-w-0"
                                />
                            ) : null)}
                    </div>
                )}

                {isLoadingMore ? (
                    <div
                        className={SHOWCASE_FEED_GRID_CLASS}
                        aria-hidden="true"
                        data-showcase-load-more-skeleton="true"
                    >
                        {Array.from(
                            { length: getShowcaseDeferredRevealBatchSize() },
                            (_, index) => (
                                <div key={index} className="min-w-0">
                                    <SkeletonLoader className="h-64" />
                                </div>
                            )
                        )}
                    </div>
                ) : null}

                {pageInfo.hasMore && !isLoadingInitialFeed && !hasDeferredItems ? (
                    <div
                        ref={loadMoreSentinelRef}
                        data-showcase-load-more-sentinel="true"
                        aria-hidden="true"
                        className="h-1"
                    />
                ) : null}

                {loadMoreError ? (
                    <div role="alert" className="mt-8 flex flex-col items-start justify-between gap-4 rounded-[24px] border border-rose-300/25 bg-rose-400/10 p-4 sm:flex-row sm:items-center">
                        <div>
                            <p className="text-sm font-bold text-rose-200">Could not load more posts</p>
                            <p className="mt-1 text-sm text-[var(--ui-text-secondary)]">{loadMoreError}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void loadMore()}
                            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-rose-300/25 bg-rose-400/10 px-4 text-sm font-bold text-rose-100 transition hover:bg-rose-400/15"
                        >
                            <RefreshCw className="h-4 w-4" aria-hidden />
                            Retry
                        </button>
                    </div>
                ) : null}

                {pageInfo.hasMore && !isLoadingInitialFeed && !hasDeferredItems && (
                    <div className="mt-12 text-center">
                        <button
                            type="button"
                            onClick={() => void loadMore()}
                            disabled={isLoadingMore}
                            className="ui-focus-ring min-h-12 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-6 text-sm font-bold text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-surface-3)] disabled:opacity-50"
                        >
                            {isLoadingMore ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : 'Load More'}
                        </button>
                    </div>
                )}

                {!pageInfo.hasMore && tileableItems.length > 0 && !hasDeferredItems ? (
                    <div className="mt-12 flex flex-col items-center gap-3 text-center">
                        <p className="text-sm font-semibold text-[var(--ui-text-muted)]">{endOfLaneMessage}</p>
                        <button
                            type="button"
                            onClick={() => void refreshLane()}
                            disabled={isRefreshingLane}
                            aria-busy={isRefreshingLane}
                            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-6 text-sm font-bold text-[var(--ui-text-primary)] transition hover:bg-[var(--ui-surface-3)] disabled:opacity-50"
                        >
                            <RefreshCw className={`h-4 w-4 ${isRefreshingLane ? 'animate-spin' : ''}`} aria-hidden />
                            Refresh
                        </button>
                    </div>
                ) : null}
            </div>

            {feedbackNotice ? (
                <div
                    role={feedbackNotice.tone === 'error' ? 'alert' : 'status'}
                    aria-live={feedbackNotice.tone === 'error' ? 'assertive' : 'polite'}
                    className={`fixed bottom-5 left-1/2 z-[110] flex w-[min(calc(100%-2rem),32rem)] -translate-x-1/2 items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm shadow-[0_18px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl ${
                        feedbackNotice.tone === 'error'
                            ? 'border-rose-300/25 bg-[rgba(70,20,28,0.96)] text-rose-50'
                            : 'border-emerald-300/20 bg-[rgba(18,51,42,0.96)] text-emerald-50'
                    }`}
                >
                    <span className="leading-6">{feedbackNotice.message}</span>
                    <button
                        type="button"
                        onClick={() => setFeedbackNotice(null)}
                        className="ui-focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-current transition hover:bg-white/10"
                        aria-label="Dismiss feedback message"
                    >
                        <X className="h-4 w-4" aria-hidden />
                    </button>
                </div>
            ) : null}

            {selectedItemId ? (
                <ShowcaseReelViewer
                    isOpen
                    items={items}
                    selectedItemId={selectedItemId}
                    initialMediaIndex={selectedMediaIndex}
                    savedItemIds={savedItemIds}
                    accessToken={session?.access_token ?? null}
                    hasMoreItems={pageInfo.hasMore}
                    isLoadingMoreItems={isLoadingMore}
                    loadMoreError={loadMoreError}
                    onLoadMoreItems={loadMore}
                    onClose={closePreview}
                    onSelectItemId={selectPreviewItem}
                    selectedItemStatus={directPostStatus}
                    onRetrySelectedItem={retryDirectPost}
                    onCommentCountChange={updateCommentCount}
                    onMediaIndexChange={(mediaIndex) => {
                        setSelectedMediaIndex(mediaIndex);
                        updateReelUrl(selectedItemId, 'replace', mediaIndex);
                    }}
                    onToggleSave={(id) => toggleSave(id, 'showcase-reel')}
                    onRemix={(id) => handleRemix(id, 'showcase-reel')}
                    feedSessionId={feedSessionId}
                    onFeedback={(feedbackItem, action) => handleFeedFeedback(
                        feedbackItem,
                        action,
                        'showcase-reel'
                    )}
                    onReportContent={(reportedItem) => handleReportContent(reportedItem, 'reel')}
                    onReportUser={(reportedItem) => handleReportUser(reportedItem, 'reel')}
                    onBlockUser={handleBlockUser}
                    buildDetailPath={buildCommunityDetailPath}
                />
            ) : null}
        </div>
    );
}
