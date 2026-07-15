'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Heart, Image as ImageIcon, Video, Layers, TrendingUp, ShoppingBag, BookText, BadgeDollarSign, SlidersHorizontal, X, RefreshCw } from 'lucide-react';
import { useAuth } from '@/app/components/AuthProvider';
import CreatorIdentity from '@/app/components/CreatorIdentity';
import PublicShareButton from '@/app/components/PublicShareButton';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import {
    QualifiedImpressionBoundary,
    ShowcaseFeedbackMenu,
    getShowcaseFeedSessionId,
    sendShowcaseFeedEvent,
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
    type ShowcaseResourceFilter,
    type ShowcaseSort,
    type ShowcaseUnlockFilter,
    isGenerationRecipeAssetId,
} from '@/lib/showcase';
import {
    formatPostResourceBundleCountSummary,
    getBundleAccessLabel,
    getPostResourceKindLabel,
    isPostResourceKind,
    type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { buildShowcaseDetailPath } from '@/lib/share';
import { formatSourceToolsCompact, type SourceToolOption } from '@/lib/source-tools';

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
    () => import('@/app/showcase/ShowcaseReelViewer'),
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
    { id: 'text', label: 'Tips', icon: BookText },
];

const SORTS: Array<{ id: ShowcaseSort; label: string }> = [
    { id: 'for-you', label: 'For you' },
    { id: 'recent', label: 'Recent' },
    { id: 'top-saves', label: 'Saved' },
    { id: 'top-remixes', label: 'Remixed' },
    { id: 'top-sales', label: 'Sales' },
];

const DEFAULT_SHOWCASE_SORT: ShowcaseSort = 'for-you';

function scheduleIdleWork(callback: () => void, timeout = 1_000): () => void {
    if (typeof window.requestIdleCallback === 'function') {
        const handle = window.requestIdleCallback(callback, { timeout });
        return () => {
            if (typeof window.cancelIdleCallback === 'function') {
                window.cancelIdleCallback(handle);
            }
        };
    }

    const handle = window.setTimeout(callback, 80);
    return () => window.clearTimeout(handle);
}

function scheduleDelayedIdleWork(
    callback: () => void,
    delay = 1_000,
    idleTimeout = 3_000
): () => void {
    let cancelIdleWork: (() => void) | null = null;
    const handle = window.setTimeout(() => {
        cancelIdleWork = scheduleIdleWork(callback, idleTimeout);
    }, delay);

    return () => {
        window.clearTimeout(handle);
        cancelIdleWork?.();
    };
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
    { id: 'remix', label: 'Remix' },
];

interface ShowcaseClientProps {
    initialFeed: ShowcaseFeedPage;
    initialCategory: ShowcaseCategory;
    initialSort: ShowcaseSort;
    initialTool: string | null;
    initialUnlock: ShowcaseUnlockFilter;
    initialResource: ShowcaseResourceFilter;
    sourceToolOptions: SourceToolOption[];
}

function getItemSummary(item: ShowcaseFeedItem): string {
    if (item.body.trim()) {
        return item.body;
    }

    if (item.prompt.trim()) {
        return item.prompt;
    }

    const toolLabel = item.sourceTools && item.sourceTools.length > 0
      ? formatSourceToolsCompact(item.sourceTools)
      : item.sourceTool ?? item.model;
    const creatorLabel = item.creator.name;
    const metadata = [
        toolLabel ? `Made with ${toolLabel}` : null,
        `${item.category === 'text' ? 'Tip' : item.category} by ${creatorLabel}`,
    ].filter(Boolean);

    if (item.asset) {
        const kinds = getItemResourceKinds(item);
        const bundleCountSummary = formatPostResourceBundleCountSummary(item.asset.lockedPreview ?? null);
        const unlockSummary = bundleCountSummary
            ? `Unlock includes ${bundleCountSummary}.`
            : kinds.length > 0
            ? `Unlock includes ${formatResourceKinds(kinds).toLowerCase()}.`
            : 'Reusable unlock attached.';

        return [...metadata, unlockSummary].join(' · ');
    }

    return metadata.join(' · ');
}

function getItemResourceKinds(item: ShowcaseFeedItem): PostResourceKind[] {
    return (item.asset?.resourceKinds ?? []).filter(isPostResourceKind);
}

function formatResourceKinds(kinds: PostResourceKind[]): string {
    if (kinds.length === 0) {
        return 'Reusable parts';
    }

    return kinds.map((kind) => getPostResourceKindLabel(kind)).join(' + ');
}

function getAssetAccessLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
    if (isGenerationRecipeAssetId(asset.id)) {
        return 'Public recipe';
    }

    if (asset.priceQuote) {
        return formatBundleAccessLabel({
            accessMode: asset.accessMode,
            priceQuote: asset.priceQuote,
        });
    }

    return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents);
}

function getAssetPurchaseCtaLabel(asset: NonNullable<ShowcaseFeedItem['asset']>): string {
    if (isGenerationRecipeAssetId(asset.id)) {
        return 'View recipe';
    }

    if (asset.accessMode === 'free' || asset.priceUsdCents === 0) {
        return 'Open free unlock';
    }

    return `Unlock for ${asset.priceQuote?.formatted ?? getBundleAccessLabel(asset.accessMode, asset.priceUsdCents).replace(/\s+unlock$/i, '')}`;
}

function setNonDefaultParam(params: URLSearchParams, key: string, value: string, defaultValue: string) {
    if (value !== defaultValue) {
        params.set(key, value);
    }
}

function getItemMediaItems(item: ShowcaseFeedItem): ShowcaseMediaItem[] {
    if (item.mediaItems?.length) {
        return item.mediaItems;
    }

    if (!item.mediaUrl || !item.mediaKind) {
        return [];
    }

    return [{
        id: `${item.id}:cover`,
        url: item.mediaUrl,
        mediaKind: item.mediaKind,
        contentType: null,
        originalName: null,
        width: null,
        height: null,
        durationSeconds: null,
        sortOrder: 0,
    }];
}

function filterSessionHiddenItems(
    feedItems: ShowcaseFeedItem[],
    hiddenPostIds: Set<string>,
    hiddenCreatorIds: Set<string>
) {
    return feedItems.filter((item) => (
        !hiddenPostIds.has(item.id)
        && (!item.creator.id || !hiddenCreatorIds.has(item.creator.id))
    ));
}

export default function ShowcaseClient({
    initialFeed,
    initialCategory,
    initialSort,
    initialTool,
    initialUnlock,
    initialResource,
    sourceToolOptions,
}: ShowcaseClientProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { session, user, isLoading: isAuthLoading } = useAuth();
    const [isPending, startTransition] = useTransition();
    const feedItemsForEventsRef = useRef<ShowcaseFeedItem[]>(initialFeed.items);
    const feedSessionIdForEventsRef = useRef<string | null>(getShowcaseFeedSessionId(initialFeed));
    const {
        items,
        setItems,
        savedItemIds,
        setSavedItemIds,
        savingItemIds,
        toggleSave,
    } = useOptimisticPostSave({
        initialItems: initialFeed.items,
        accessToken: session?.access_token ?? null,
        isSignedIn: Boolean(user && session?.access_token),
        onAuthRequired: () => router.push('/login?returnUrl=/showcase'),
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
    const [pageInfo, setPageInfo] = useState(initialFeed.pageInfo);
    const [feedSessionId, setFeedSessionId] = useState(() => getShowcaseFeedSessionId(initialFeed));
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [renderedItemCount, setRenderedItemCount] = useState(() => (
        Math.min(SHOWCASE_INITIAL_RENDER_COUNT, initialFeed.items.length)
    ));
    const [feedbackNotice, setFeedbackNotice] = useState<{
        tone: 'success' | 'error';
        message: string;
    } | null>(null);
    const [selectedMediaIndex, setSelectedMediaIndex] = useState(() => {
        const value = Number(searchParams.get('media'));
        return Number.isInteger(value) && value >= 0 ? value : 0;
    });
    const isLoadingMoreRef = useRef(false);
    const anonymousHiddenPostIdsRef = useRef(new Set<string>());
    const anonymousHiddenCreatorIdsRef = useRef(new Set<string>());
    const anonymousPersonalizationStartedRef = useRef(false);
    const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
    const reelHistoryModeRef = useRef<'pushed' | 'direct' | null>(
        searchParams.get('post') ? 'direct' : null
    );
    const directPostRequestRef = useRef<string | null>(null);
    const selectedItemIdRef = useRef<string | null>(selectedItemId);

    useEffect(() => {
        selectedItemIdRef.current = selectedItemId;
        feedItemsForEventsRef.current = items;
        feedSessionIdForEventsRef.current = feedSessionId;
    }, [feedSessionId, items, selectedItemId]);

    const currentShowcasePath = searchParams.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname;

    const buildCommunityDetailPath = (id: string, section?: string) =>
        buildShowcaseDetailPath(id, {
            from: 'community',
            returnTo: currentShowcasePath,
            section,
        });
    const isLoadingInitialFeed = isPending && items.length === 0 && !isAuthLoading;
    const renderedItems = items.slice(0, renderedItemCount);
    const hasDeferredItems = renderedItemCount < items.length;
    const hasAuthenticatedSession = Boolean(user && session?.access_token);
    const shouldWaitForAnonymousReveal = !user && !hasAuthenticatedSession && hasDeferredItems;
    const priorityMediaItemId = renderedItems.find((item) => (
        item.postFormat !== 'text' && getItemMediaItems(item).length > 0
    ))?.id ?? null;

    useEffect(() => {
        const postParam = searchParams.get('post');
        const mediaParam = Number(searchParams.get('media'));
        // Browser history is the source of truth for the active reel and media index.
        setSelectedMediaIndex(Number.isInteger(mediaParam) && mediaParam >= 0 ? mediaParam : 0);

        if (!postParam) {
            directPostRequestRef.current = null;
            reelHistoryModeRef.current = null;
            setSelectedItemId(null);
            return;
        }

        if (reelHistoryModeRef.current === null) {
            reelHistoryModeRef.current = 'direct';
        }

        if (items.some((item) => item.id === postParam)) {
            directPostRequestRef.current = postParam;
            setSelectedItemId(postParam);
            return;
        }

        if (directPostRequestRef.current === postParam) {
            return;
        }

        directPostRequestRef.current = postParam;
        const controller = new AbortController();

        void fetch(`/api/showcase/posts/${encodeURIComponent(postParam)}`, {
            headers: session?.access_token
                ? {
                    Authorization: `Bearer ${session.access_token}`,
                }
                : undefined,
            signal: controller.signal,
        })
            .then(async (response) => {
                const payload = await response.json();
                if (!response.ok || !payload?.item) {
                    throw new Error(payload?.error || 'Post not found.');
                }

                const sharedItem = payload.item as ShowcaseFeedItem;
                setItems((currentItems) => currentItems.some((item) => item.id === sharedItem.id)
                    ? currentItems
                    : [...currentItems, sharedItem]);
                setSelectedItemId(sharedItem.id);
            })
            .catch((error) => {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    return;
                }

                console.error('Failed to load shared showcase post:', error);
            });

        return () => {
            controller.abort();
        };
    }, [items, searchParams, session?.access_token, setItems]);

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

    const openPreview = (item: ShowcaseFeedItem, mediaIndex = 0) => {
        reelHistoryModeRef.current = 'pushed';
        setSelectedMediaIndex(mediaIndex);
        updateReelUrl(item.id, 'push', mediaIndex);
        setSelectedItemId(item.id);
    };

    const closePreview = () => {
        setSelectedItemId(null);

        if (reelHistoryModeRef.current === 'pushed') {
            reelHistoryModeRef.current = null;
            window.history.back();
            return;
        }

        reelHistoryModeRef.current = null;
        updateReelUrl(null, 'replace');
    };

    useEffect(() => {
        const handlePopState = () => {
            const postParam = new URLSearchParams(window.location.search).get('post');
            const mediaParam = Number(new URLSearchParams(window.location.search).get('media'));
            reelHistoryModeRef.current = postParam ? 'direct' : null;
            setSelectedMediaIndex(Number.isInteger(mediaParam) && mediaParam >= 0 ? mediaParam : 0);

            if (!postParam) {
                setSelectedItemId(null);
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    useEffect(() => {
        const visibleInitialItems = user
            ? initialFeed.items
            : filterSessionHiddenItems(
                initialFeed.items,
                anonymousHiddenPostIdsRef.current,
                anonymousHiddenCreatorIdsRef.current
            );
        // A server navigation replaces the feed snapshot and its pagination/filter state.
        setItems(visibleInitialItems);
        setPageInfo(initialFeed.pageInfo);
        setRenderedItemCount(Math.min(SHOWCASE_INITIAL_RENDER_COUNT, visibleInitialItems.length));
        setFeedSessionId(getShowcaseFeedSessionId(initialFeed));
        setIsLoadingMore(false);
        setLoadMoreError(null);
        isLoadingMoreRef.current = false;
        anonymousPersonalizationStartedRef.current = false;
        setCategory(initialCategory);
        setSort(initialSort);
        setTool(initialTool ?? 'all');
        setUnlock(initialUnlock);
        setResource(initialResource);
        setSavedItemIds(new Set(visibleInitialItems.filter((item) => item.isSaved).map((item) => item.id)));
    }, [initialCategory, initialFeed, initialResource, initialSort, initialTool, initialUnlock, setItems, setSavedItemIds, user]);

    useEffect(() => {
        if (!hasDeferredItems) {
            return;
        }

        return scheduleIdleWork(() => {
            setRenderedItemCount((currentCount) => Math.min(currentCount + 1, items.length));
        });
    }, [hasDeferredItems, items.length, renderedItemCount]);

    useEffect(() => {
        if (isAuthLoading || sort !== DEFAULT_SHOWCASE_SORT) {
            return;
        }

        if (
            (user && !hasAuthenticatedSession)
            || (!hasAuthenticatedSession && (
                shouldWaitForAnonymousReveal
                || anonymousPersonalizationStartedRef.current
            ))
        ) {
            return;
        }

        const controller = new AbortController();
        const params = new URLSearchParams({
            limit: String(SHOWCASE_PAGE_SIZE),
        });
        setNonDefaultParam(params, 'category', category, 'all');
        setNonDefaultParam(params, 'tool', tool, 'all');
        setNonDefaultParam(params, 'unlock', unlock, 'all');
        setNonDefaultParam(params, 'resource', resource, 'all');

        const refreshPersonalizedFeed = () => {
            void fetch(`/api/showcase/feed?${params.toString()}`, {
                headers: session?.access_token
                    ? { Authorization: `Bearer ${session.access_token}` }
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

                    const visiblePersonalizedItems = user
                        ? personalizedFeed.items
                        : filterSessionHiddenItems(
                            personalizedFeed.items,
                            anonymousHiddenPostIdsRef.current,
                            anonymousHiddenCreatorIdsRef.current
                        );
                    const selectedItem = selectedItemIdRef.current
                        ? feedItemsForEventsRef.current.find((candidate) => candidate.id === selectedItemIdRef.current) ?? null
                        : null;
                    const nextItems = selectedItem && !visiblePersonalizedItems.some((candidate) => candidate.id === selectedItem.id)
                        ? [...visiblePersonalizedItems, selectedItem]
                        : visiblePersonalizedItems;
                    setItems(nextItems);
                    setRenderedItemCount((currentCount) => Math.min(
                        Math.max(SHOWCASE_INITIAL_RENDER_COUNT, currentCount),
                        nextItems.length
                    ));
                    setPageInfo(personalizedFeed.pageInfo);
                    setFeedSessionId(getShowcaseFeedSessionId(personalizedFeed));
                    setSavedItemIds(new Set(
                        visiblePersonalizedItems.filter((item) => item.isSaved).map((item) => item.id)
                    ));
                    setLoadMoreError(null);
                    isLoadingMoreRef.current = false;
                    setIsLoadingMore(false);
                })
                .catch((error) => {
                    if (!controller.signal.aborted) {
                        console.error('Failed to refresh personalized showcase feed:', error);
                    }
                });
        };
        // Signed-in viewers should see their ranking immediately. Anonymous
        // viewers already have a useful server bootstrap, so establish their
        // feed session only after critical hydration work has yielded.
        const cancelScheduledRefresh = hasAuthenticatedSession
            ? (refreshPersonalizedFeed(), null)
            : scheduleDelayedIdleWork(() => {
                anonymousPersonalizationStartedRef.current = true;
                refreshPersonalizedFeed();
            });

        return () => {
            cancelScheduledRefresh?.();
            controller.abort();
        };
    }, [
        category,
        hasAuthenticatedSession,
        initialFeed,
        isAuthLoading,
        resource,
        session,
        setItems,
        setSavedItemIds,
        shouldWaitForAnonymousReveal,
        sort,
        tool,
        unlock,
        user,
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
        const params = new URLSearchParams();

        if (nextCategory !== 'all') {
            params.set('category', nextCategory);
        }

        if (nextSort !== DEFAULT_SHOWCASE_SORT) {
            params.set('sort', nextSort);
        }

        if (nextTool && nextTool !== 'all') {
            params.set('tool', nextTool);
        }

        if (nextUnlock !== 'all') {
            params.set('unlock', nextUnlock);
        }

        if (nextResource !== 'all') {
            params.set('resource', nextResource);
        }

        startTransition(() => {
            router.replace(params.size > 0 ? `${pathname}?${params.toString()}` : pathname, {
                scroll: false,
            });
        });
    };

    const loadMore = useCallback(async () => {
        const nextCursor = sort === DEFAULT_SHOWCASE_SORT ? pageInfo.nextCursor ?? null : null;
        const nextOffset = pageInfo.nextOffset;
        if (
            isLoadingMoreRef.current
            || !pageInfo.hasMore
            || (sort === DEFAULT_SHOWCASE_SORT ? !nextCursor : nextOffset === null)
        ) {
            return;
        }

        isLoadingMoreRef.current = true;
        setIsLoadingMore(true);
        setLoadMoreError(null);

        try {
            const params = new URLSearchParams({ limit: String(SHOWCASE_PAGE_SIZE) });
            if (sort === DEFAULT_SHOWCASE_SORT && nextCursor) {
                params.set('cursor', nextCursor);
            } else if (nextOffset !== null) {
                params.set('offset', String(nextOffset));
            }
            setNonDefaultParam(params, 'category', category, 'all');
            setNonDefaultParam(params, 'sort', sort, DEFAULT_SHOWCASE_SORT);
            setNonDefaultParam(params, 'tool', tool, 'all');
            setNonDefaultParam(params, 'unlock', unlock, 'all');
            setNonDefaultParam(params, 'resource', resource, 'all');

            const response = await fetch(`/api/showcase/feed?${params.toString()}`, session?.access_token ? {
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                },
            } : undefined);
            if (!response.ok) {
                throw new Error(`Feed request failed with ${response.status}`);
            }

            const nextFeed: ShowcaseFeedPage = await response.json();
            const visibleNextItems = user
                ? nextFeed.items
                : filterSessionHiddenItems(
                    nextFeed.items,
                    anonymousHiddenPostIdsRef.current,
                    anonymousHiddenCreatorIdsRef.current
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
            console.error('Failed to fetch more showcase items:', error);
            setLoadMoreError('Could not load more posts. Your current feed is still available.');
        } finally {
            isLoadingMoreRef.current = false;
            setIsLoadingMore(false);
        }
    }, [
        category,
        pageInfo.hasMore,
        pageInfo.nextCursor,
        pageInfo.nextOffset,
        resource,
        session,
        setItems,
        setSavedItemIds,
        sort,
        tool,
        unlock,
        user,
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

    const handleRemix = async (
        id: string,
        sourceSurface: ShowcaseEventSourceSurface = 'showcase'
    ) => {
        if (!user || !session?.access_token) {
            router.push('/login?returnUrl=/showcase');
            return;
        }

        try {
            const response = await fetch('/api/showcase/remix', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ generationId: id }),
            });
            const data = await response.json();

            if (data.success && data.redirectTo) {
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
                            redirectTo: data.redirectTo,
                        },
                    }).catch(() => undefined);
                }
                router.push(data.redirectTo);
            }
        } catch (error) {
            console.error('Remix failed:', error);
        }
    };

    const handleFeedFeedback = async (
        feedbackItem: ShowcaseFeedItem,
        action: ShowcaseFeedbackAction,
        sourceSurface: ShowcaseEventSourceSurface
    ) => {
        if (
            action === 'hide_creator'
            && (!feedbackItem.creator.id || feedbackItem.creator.id === user?.id)
        ) {
            return;
        }

        const itemPosition = items.findIndex((candidate) => candidate.id === feedbackItem.id);
        const removedItems = items
            .map((candidate, index) => ({ item: candidate, index }))
            .filter(({ item: candidate }) => action === 'hide_creator'
                ? candidate.creator.id === feedbackItem.creator.id
                : candidate.id === feedbackItem.id);

        if (removedItems.length === 0) {
            return;
        }

        if (!user) {
            if (action === 'hide_creator' && feedbackItem.creator.id) {
                anonymousHiddenCreatorIdsRef.current.add(feedbackItem.creator.id);
            } else {
                anonymousHiddenPostIdsRef.current.add(feedbackItem.id);
            }
        }

        const removedIds = new Set(removedItems.map(({ item: candidate }) => candidate.id));
        const remainingItems = items.filter((candidate) => !removedIds.has(candidate.id));
        setFeedbackNotice(null);
        setItems(remainingItems);

        if (selectedItemId && removedIds.has(selectedItemId)) {
            const replacementItem = remainingItems[Math.min(
                Math.max(itemPosition, 0),
                Math.max(remainingItems.length - 1, 0)
            )] ?? null;

            if (replacementItem) {
                selectPreviewItem(replacementItem.id);
            } else {
                closePreview();
            }
        }

        try {
            await sendShowcaseFeedEvent({
                item: feedbackItem,
                eventType: action,
                sourceSurface,
                accessToken: session?.access_token ?? null,
                feedSessionId,
                fallbackPosition: itemPosition >= 0 ? itemPosition : undefined,
                metadata: {
                    creatorId: feedbackItem.creator.id,
                },
            });
            setFeedbackNotice({
                tone: 'success',
                message: !user
                    ? action === 'hide_creator'
                        ? `Posts from ${feedbackItem.creator.name} are hidden for this visit.`
                        : 'Post removed for this visit.'
                    : action === 'hide_creator'
                        ? `Posts from ${feedbackItem.creator.name} are now hidden.`
                        : 'Thanks. We’ll show you fewer posts like that.',
            });
        } catch (error) {
            console.error('Failed to save showcase feedback:', error);
            if (!user) {
                if (action === 'hide_creator' && feedbackItem.creator.id) {
                    anonymousHiddenCreatorIdsRef.current.delete(feedbackItem.creator.id);
                } else {
                    anonymousHiddenPostIdsRef.current.delete(feedbackItem.id);
                }
            }
            setItems((currentItems) => {
                const restoredItems = [...currentItems];
                removedItems.forEach(({ item: removedItem, index }) => {
                    if (!restoredItems.some((candidate) => candidate.id === removedItem.id)) {
                        restoredItems.splice(Math.min(index, restoredItems.length), 0, removedItem);
                    }
                });
                return restoredItems;
            });
            setFeedbackNotice({
                tone: 'error',
                message: 'We couldn’t save that preference, so the post was restored. Please try again.',
            });
        }
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
                            Feed
                        </h1>
                        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ui-text-muted)] sm:text-base">
                            Fresh creator posts with unlocks mixed in. Browse the result, then save it, remix it, or open the reusable process.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Link
                            href="/post/new"
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
                            Browse unlocks
                        </Link>
                    </div>
                </div>

                <div className="sticky top-[72px] z-30 mb-7 rounded-[28px] border border-[var(--ui-border-default)] bg-[rgba(25,25,28,0.92)] p-3 shadow-[0_12px_30px_rgba(0,0,0,0.24)] backdrop-blur-xl sm:p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex gap-2 overflow-x-auto pb-1 sm:pb-0 w-full sm:w-auto hide-scrollbar">
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
                                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Unlock</div>
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
                </div>

                {isLoadingInitialFeed ? (
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((placeholder) => (
                            <div key={placeholder} className="break-inside-avoid mb-6">
                                <SkeletonLoader className="h-64" />
                            </div>
                        ))}
                    </div>
                ) : items.length === 0 ? (
                    <div className="rounded-[28px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-6 py-16 text-center text-[var(--ui-text-muted)]">
                        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--ui-surface-2)] text-[var(--ui-text-faint)]">
                            <ImageIcon className="h-6 w-6" aria-hidden />
                        </span>
                        <p className="text-lg font-bold text-[var(--ui-text-primary)]">Nothing in this lane yet</p>
                        <p className="mt-2 text-sm">Clear a filter or share a result, tip, prompt, or workflow to start it.</p>
                        <Link href="/post/new" className="ui-focus-ring mt-5 inline-flex min-h-12 items-center rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)]">
                            Share the first post
                        </Link>
                    </div>
                ) : (
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6">
                            {renderedItems.map((item, itemIndex) => {
                                const resourceKinds = getItemResourceKinds(item);
                                const isSaved = savedItemIds.has(item.id);
                                const mediaItems = getItemMediaItems(item);
                                const isMixedMedia = new Set(mediaItems.map((mediaItem) => mediaItem.mediaKind)).size > 1;

                                return (
                                    <QualifiedImpressionBoundary
                                        key={item.id}
                                        item={item}
                                        position={itemIndex}
                                        feedSessionId={feedSessionId}
                                        accessToken={session?.access_token ?? null}
                                        className="break-inside-avoid mb-6 flex flex-col"
                                    >
                                        {/* Pinterest Style Card Frame */}
                                        <div className="group relative overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] transition duration-200 hover:border-[rgba(255,122,89,0.28)] hover:shadow-[0_12px_40px_rgba(0,0,0,0.42)] focus-within:border-[rgba(255,122,89,0.34)]">
                                            <div className="relative overflow-hidden bg-black">
                                                {item.postFormat === 'text' ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => openPreview(item)}
                                                        className="block w-full text-left"
                                                    >
                                                    <TextPostPreviewCard
                                                        title={item.title}
                                                        summary={getItemSummary(item)}
                                                        sourceLabel={item.sourceTool || item.model}
                                                        dateLabel={formatShowcaseDate(item.createdAt)}
                                                        saveCount={item.saveCount}
                                                        remixCount={item.remixCount}
                                                        unlockLabel={item.asset ? getAssetAccessLabel(item.asset) : null}
                                                        resourceKinds={getItemResourceKinds(item)}
                                                        className="rounded-none border-0 shadow-none"
                                                    />
                                                    </button>
                                                ) : mediaItems.length > 0 ? (
                                                    <ShowcaseMediaCarousel
                                                        mediaItems={mediaItems}
                                                        title={item.title}
                                                        priority={item.id === priorityMediaItemId}
                                                        onOpen={(mediaIndex) => openPreview(item, mediaIndex)}
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
                                                    {item.postFormat !== 'text' ? (
                                                        <div className="px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full text-[11px] font-medium border border-white/10 flex items-center gap-1.5 text-white">
                                                            <span>{isMixedMedia ? 'Mixed' : item.category}</span>
                                                        </div>
                                                    ) : <div />}
                                                    <ShowcaseFeedbackMenu
                                                        itemTitle={item.title}
                                                        creatorName={item.creator.name}
                                                        canHideCreator={Boolean(
                                                            item.creator.id && item.creator.id !== user?.id
                                                        )}
                                                        sessionOnly={!user}
                                                        onSelect={(action) => handleFeedFeedback(item, action, 'showcase')}
                                                    />
                                                </div>

                                                <div className="flex items-center justify-end gap-2 pointer-events-auto">
                                                    <PublicShareButton
                                                        generationId={item.id}
                                                        title={item.title}
                                                        description={item.body || item.prompt}
                                                        sourceSurface="showcase"
                                                        accessToken={session?.access_token ?? null}
                                                        onShared={() => {
                                                            void sendShowcaseFeedEvent({
                                                                item,
                                                                eventType: 'share',
                                                                sourceSurface: 'showcase',
                                                                accessToken: session?.access_token ?? null,
                                                                feedSessionId,
                                                                fallbackPosition: itemIndex,
                                                            }).catch(() => undefined);
                                                        }}
                                                        iconOnly
                                                        className="ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ui-text-primary)] text-[var(--ui-primary-on)] shadow-md transition hover:bg-white"
                                                    />

                                                    {item.asset ? (
                                                        <Link
                                                            href={buildCommunityDetailPath(item.id, 'resources')}
                                                            prefetch={false}
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
                                                            void toggleSave(item.id);
                                                        }}
                                                        disabled={savingItemIds.has(item.id)}
                                                        aria-label={`${isSaved ? 'Remove save from' : 'Save'} ${item.title}. ${item.saveCount} saves`}
                                                        aria-pressed={isSaved}
                                                        aria-busy={savingItemIds.has(item.id)}
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

                                            {/* Unlock and Resource Badges */}
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
                            })}
                    </div>
                )}

                {pageInfo.hasMore && !isLoadingInitialFeed && !hasDeferredItems ? (
                    <div
                        ref={loadMoreSentinelRef}
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
                    savingItemIds={savingItemIds}
                    accessToken={session?.access_token ?? null}
                    hasMoreItems={pageInfo.hasMore}
                    isLoadingMoreItems={isLoadingMore}
                    onLoadMoreItems={loadMore}
                    onClose={closePreview}
                    onSelectItemId={selectPreviewItem}
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
                    buildDetailPath={buildCommunityDetailPath}
                />
            ) : null}
        </div>
    );
}
