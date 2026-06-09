'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Heart, Image as ImageIcon, Video, Layers, Users, TrendingUp, ShoppingBag, BookText, BadgeDollarSign, SlidersHorizontal, X } from 'lucide-react';
import { useAuth } from '@/app/components/AuthProvider';
import CreatorIdentity from '@/app/components/CreatorIdentity';
import PublicShareButton from '@/app/components/PublicShareButton';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import ShowcaseReelViewer from '@/app/showcase/ShowcaseReelViewer';
import {
    SHOWCASE_PAGE_SIZE,
    type ShowcaseCategory,
    type ShowcaseFeedItem,
    type ShowcaseFeedPage,
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

const CATEGORIES: Array<{
    id: ShowcaseCategory;
    label: string;
    icon: typeof Layers;
}> = [
    { id: 'all', label: 'All posts', icon: Layers },
    { id: 'image', label: 'Images', icon: ImageIcon },
    { id: 'video', label: 'Videos', icon: Video },
    { id: 'motion', label: 'Motion', icon: Users },
    { id: 'text', label: 'Tips', icon: BookText },
];

const SORTS: Array<{ id: ShowcaseSort; label: string }> = [
    { id: 'recent', label: 'Recent' },
    { id: 'top-saves', label: 'Saved' },
    { id: 'top-remixes', label: 'Remixed' },
    { id: 'top-sales', label: 'Sales' },
];

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

function primePreviewVideoFrame(video: HTMLVideoElement) {
    const previewTime = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(0.1, Math.max(video.duration * 0.05, 0.01))
        : 0.1;

    if (Math.abs(video.currentTime - previewTime) < 0.01) {
        return;
    }

    try {
        video.currentTime = previewTime;
    } catch {
        // Some browsers can reject seek requests before enough data is buffered.
    }
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
    });
    const [category, setCategory] = useState(initialCategory);
    const [sort, setSort] = useState(initialSort);
    const [tool, setTool] = useState(initialTool ?? 'all');
    const [unlock, setUnlock] = useState<ShowcaseUnlockFilter>(initialUnlock);
    const [resource, setResource] = useState<ShowcaseResourceFilter>(initialResource);
    const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
    const [pageInfo, setPageInfo] = useState(initialFeed.pageInfo);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const isLoadingMoreRef = useRef(false);
    const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
    const previewVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
    const reelHistoryModeRef = useRef<'pushed' | 'direct' | null>(
        searchParams.get('post') ? 'direct' : null
    );
    const directPostRequestRef = useRef<string | null>(null);

    const registerPreviewVideo = (id: string, node: HTMLVideoElement | null) => {
        previewVideoRefs.current[id] = node;
    };

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

    useEffect(() => {
        const postParam = searchParams.get('post');

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

    const updateReelUrl = useCallback((postId: string | null, mode: 'push' | 'replace') => {
        const params = new URLSearchParams(window.location.search);
        if (postId) {
            params.set('post', postId);
        } else {
            params.delete('post');
        }

        const nextUrl = params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
        if (mode === 'push') {
            window.history.pushState(null, '', nextUrl);
        } else {
            window.history.replaceState(null, '', nextUrl);
        }
    }, [pathname]);

    const selectPreviewItem = useCallback((id: string) => {
        updateReelUrl(id, 'replace');
        setSelectedItemId(id);
    }, [updateReelUrl]);

    const openPreview = (item: ShowcaseFeedItem) => {
        reelHistoryModeRef.current = 'pushed';
        updateReelUrl(item.id, 'push');
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
            reelHistoryModeRef.current = postParam ? 'direct' : null;

            if (!postParam) {
                setSelectedItemId(null);
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    useEffect(() => {
        setItems(initialFeed.items);
        setPageInfo(initialFeed.pageInfo);
        setIsLoadingMore(false);
        isLoadingMoreRef.current = false;
        setCategory(initialCategory);
        setSort(initialSort);
        setTool(initialTool ?? 'all');
        setUnlock(initialUnlock);
        setResource(initialResource);
        setSavedItemIds(new Set(initialFeed.items.filter((item) => item.isSaved).map((item) => item.id)));
    }, [initialCategory, initialFeed, initialResource, initialSort, initialTool, initialUnlock, setItems, setSavedItemIds]);

    useEffect(() => {
        const handleVisibilityChange = () => {
            Object.values(previewVideoRefs.current).forEach((video) => {
                if (!video) {
                    return;
                }

                if (document.hidden) {
                    video.pause();
                    return;
                }

                if (video.readyState === 0) {
                    video.load();
                    return;
                }

                primePreviewVideoFrame(video);
            });
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

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

        if (nextSort !== 'recent') {
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
        if (isLoadingMoreRef.current || !pageInfo.hasMore || pageInfo.nextOffset === null) {
            return;
        }

        isLoadingMoreRef.current = true;
        setIsLoadingMore(true);

        try {
            const params = new URLSearchParams({
                offset: String(pageInfo.nextOffset),
                limit: String(SHOWCASE_PAGE_SIZE),
            });
            setNonDefaultParam(params, 'category', category, 'all');
            setNonDefaultParam(params, 'sort', sort, 'recent');
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

            setItems((currentItems) => [
                ...currentItems,
                ...nextFeed.items.filter((item) => !currentItems.some((current) => current.id === item.id)),
            ]);
            setPageInfo(nextFeed.pageInfo);
            setSavedItemIds((currentSavedIds) => {
                const nextSavedIds = new Set(currentSavedIds);
                nextFeed.items.forEach((item) => {
                    if (item.isSaved) {
                        nextSavedIds.add(item.id);
                    }
                });
                return nextSavedIds;
            });
        } catch (error) {
            console.error('Failed to fetch more showcase items:', error);
        } finally {
            isLoadingMoreRef.current = false;
            setIsLoadingMore(false);
        }
    }, [
        category,
        pageInfo.hasMore,
        pageInfo.nextOffset,
        resource,
        session?.access_token,
        setItems,
        setSavedItemIds,
        sort,
        tool,
        unlock,
    ]);

    useEffect(() => {
        const sentinel = loadMoreSentinelRef.current;
        if (!sentinel || !pageInfo.hasMore || isLoadingInitialFeed) {
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                void loadMore();
            }
        }, {
            rootMargin: '1200px 0px',
        });

        observer.observe(sentinel);

        return () => {
            observer.disconnect();
        };
    }, [isLoadingInitialFeed, loadMore, pageInfo.hasMore]);

    const handleRemix = async (id: string) => {
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
                router.push(data.redirectTo);
            }
        } catch (error) {
            console.error('Remix failed:', error);
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
        <div className="min-h-screen bg-black py-6 text-white sm:py-8 font-[family-name:var(--font-geist-sans)]">
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(120,0,255,0.05),transparent_50%)]" />
            </div>

            <div className="studio-shell relative z-10 pt-20">
                <div className="mb-12 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100">
                            <TrendingUp className="h-3.5 w-3.5" />
                            Community
                        </div>
                        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
                            Public posts and reusable unlocks from every creator tool
                        </h1>
                        <p className="mt-4 max-w-3xl text-lg leading-8 text-zinc-400">
                            Browse public results from any AI tool, then unlock the reusable prompt, workflow, files, notes, or remix access when a creator shares the process.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <Link
                            href="/post/new"
                            className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
                        >
                            Share a post
                        </Link>
                        <Link
                            href="/marketplace"
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                        >
                            Browse unlocks
                        </Link>
                    </div>
                </div>

                <div className="mb-8 rounded-[28px] border border-white/8 bg-zinc-950/70 p-3 backdrop-blur-sm sm:p-4">
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
                                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors whitespace-nowrap disabled:opacity-70
                                        ${isActive
                                            ? 'bg-purple-600 text-white'
                                            : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700'
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
                            className="h-10 rounded-full border border-white/10 bg-zinc-900 px-3 text-sm font-medium text-zinc-100 outline-none transition hover:border-white/20 disabled:opacity-70"
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
                            className={`inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-semibold transition ${
                                isFilterPanelOpen || activeFilterPills.length > 0
                                    ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-50'
                                    : 'border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]'
                            }`}
                            aria-expanded={isFilterPanelOpen}
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
                        <div className="overflow-hidden">
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
                                            className={`shrink-0 rounded-full border px-3 py-2 text-sm font-medium transition ${tool === 'all' ? 'border-sky-300/30 bg-sky-400/15 text-sky-50' : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'}`}
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
                                                className={`shrink-0 rounded-full border px-3 py-2 text-sm font-medium transition ${tool === option.slug ? 'border-sky-300/30 bg-sky-400/15 text-sky-50' : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'}`}
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
                            className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition ${unlock === option.id ? 'border-emerald-300/30 bg-emerald-400/15 text-emerald-50' : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'}`}
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
                            className={`rounded-full border px-3 py-2 text-sm font-medium transition ${resource === option.id ? 'border-purple-300/30 bg-purple-400/15 text-purple-50' : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'}`}
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
                    <div className="text-center py-24 text-zinc-500 bg-zinc-900/20 rounded-2xl border border-zinc-800">
                        <ImageIcon className="w-12 h-12 mx-auto mb-4 opacity-20" />
                        <p className="text-lg">No community posts found in this category.</p>
                        <p className="text-sm mt-2">Share a result, tip, prompt, or workflow to start this lane.</p>
                    </div>
                ) : (
                    <div className="columns-1 sm:columns-2 lg:columns-3 xl:columns-4 gap-6 space-y-6">
                            {items.map((item) => {
                                const resourceKinds = getItemResourceKinds(item);
                                const isSaved = savedItemIds.has(item.id);

                                return (
                                    <div
                                        key={item.id}
                                        className="break-inside-avoid mb-6 flex flex-col"
                                    >
                                        {/* Pinterest Style Card Frame */}
                                        <div className="group relative overflow-hidden rounded-[1.5rem] bg-[#09090b] border border-white/[0.04] hover:border-purple-500/30 hover:shadow-[0_12px_40px_rgba(0,0,0,0.65)] transition-all duration-300">
                                            <button
                                                type="button"
                                                onClick={() => openPreview(item)}
                                                className="relative bg-black overflow-hidden block w-full text-left"
                                            >
                                                {item.postFormat === 'text' ? (
                                                    <TextPostPreviewCard
                                                        title={item.title}
                                                        summary={getItemSummary(item)}
                                                        sourceLabel={item.sourceTool || item.model}
                                                        dateLabel={new Date(item.createdAt).toLocaleDateString('en-US', {
                                                            month: 'short',
                                                            day: 'numeric',
                                                        })}
                                                        saveCount={item.saveCount}
                                                        remixCount={item.remixCount}
                                                        unlockLabel={item.asset ? getAssetAccessLabel(item.asset) : null}
                                                        resourceKinds={getItemResourceKinds(item)}
                                                        className="rounded-none border-0 shadow-none"
                                                    />
                                                ) : item.mediaKind === 'video' && item.mediaUrl ? (
                                                    <video
                                                        ref={(node) => registerPreviewVideo(item.id, node)}
                                                        src={item.mediaUrl}
                                                        muted
                                                        loop
                                                        playsInline
                                                        preload="metadata"
                                                        className="w-full h-auto block object-cover"
                                                        onLoadedData={(event) => {
                                                            primePreviewVideoFrame(event.currentTarget);
                                                        }}
                                                    />
                                                ) : item.mediaUrl ? (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img
                                                        src={item.mediaUrl}
                                                        alt={item.title}
                                                        loading="lazy"
                                                        decoding="async"
                                                        className="w-full h-auto block object-cover"
                                                    />
                                                ) : (
                                                    <div className="flex min-h-[240px] items-center justify-center bg-zinc-950 text-zinc-500">
                                                        <BookText className="h-10 w-10" />
                                                    </div>
                                                )}
                                            </button>

                                            {/* Hover State Controls Overlay (Pinterest Style) */}
                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-20 flex flex-col justify-between p-4">
                                                <div className="flex justify-between items-start pointer-events-auto">
                                                    {item.postFormat !== 'text' ? (
                                                        <div className="px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full text-[11px] font-medium border border-white/10 flex items-center gap-1.5 text-white">
                                                            <span className="capitalize">{item.category}</span>
                                                        </div>
                                                    ) : <div />}
                                                </div>

                                                <div className="flex items-center justify-end gap-2 pointer-events-auto">
                                                    <PublicShareButton
                                                        generationId={item.id}
                                                        title={item.title}
                                                        description={item.body || item.prompt}
                                                        sourceSurface="showcase"
                                                        accessToken={session?.access_token ?? null}
                                                        iconOnly
                                                        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-black hover:bg-white transition-all shadow-md"
                                                    />

                                                    {item.asset ? (
                                                        <Link
                                                            href={buildCommunityDetailPath(item.id, 'resources')}
                                                            prefetch={false}
                                                            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/90 text-white hover:bg-emerald-500 transition-all shadow-md"
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
                                                        className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-all shadow-md ${
                                                            isSaved
                                                                ? 'bg-rose-600 text-white hover:bg-rose-700'
                                                                : 'bg-white/90 text-black hover:bg-white'
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
                                                    {new Date(item.createdAt).toLocaleDateString('en-US', {
                                                        month: 'short',
                                                        day: 'numeric',
                                                    })}
                                                </span>
                                            </div>

                                            <div className="flex items-center justify-between gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <CreatorIdentity creator={item.creator} compact prefetch={false} />
                                                </div>
                                                <div className="flex items-center gap-1 text-zinc-500 text-[11px] font-semibold">
                                                    <Heart className={`w-3.5 h-3.5 ${isSaved ? 'fill-pink-500 text-pink-500' : ''}`} />
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
                                    </div>
                                );
                            })}
                    </div>
                )}

                {pageInfo.hasMore && !isLoadingInitialFeed ? (
                    <div
                        ref={loadMoreSentinelRef}
                        aria-hidden="true"
                        className="h-1"
                    />
                ) : null}

                {pageInfo.hasMore && !isLoadingInitialFeed && (
                    <div className="mt-12 text-center">
                        <button
                            type="button"
                            onClick={() => void loadMore()}
                            disabled={isLoadingMore}
                            className="px-6 py-3 bg-zinc-900 border border-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-800 hover:border-zinc-600 transition-all disabled:opacity-50"
                        >
                            {isLoadingMore ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : 'Load More'}
                        </button>
                    </div>
                )}
            </div>

            <ShowcaseReelViewer
                isOpen={Boolean(selectedItemId)}
                items={items}
                selectedItemId={selectedItemId}
                savedItemIds={savedItemIds}
                savingItemIds={savingItemIds}
                accessToken={session?.access_token ?? null}
                hasMoreItems={pageInfo.hasMore}
                isLoadingMoreItems={isLoadingMore}
                onLoadMoreItems={loadMore}
                onClose={closePreview}
                onSelectItemId={selectPreviewItem}
                onToggleSave={toggleSave}
                onRemix={handleRemix}
                buildDetailPath={buildCommunityDetailPath}
            />
        </div>
    );
}
