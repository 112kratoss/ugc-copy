'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Heart, Wand2, Image as ImageIcon, Video, Layers, Users, TrendingUp, ShoppingBag, BookText, BadgeDollarSign, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/app/components/AuthProvider';
import CreatorIdentity from '@/app/components/CreatorIdentity';
import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import TextPostPreviewCard from '@/app/components/TextPostPreviewCard';
import { useOptimisticPostSave } from '@/app/components/useOptimisticPostSave';
import {
    SHOWCASE_PAGE_SIZE,
    type ShowcaseCategory,
    type ShowcaseFeedItem,
    type ShowcaseFeedPage,
    type ShowcaseResourceFilter,
    type ShowcaseSort,
    type ShowcaseUnlockFilter,
} from '@/lib/showcase';
import {
    formatUnlockCountLabel,
    getBundleAccessLabel,
    getPostResourceKindLabel,
    isPostResourceKind,
    type PostResourceKind,
} from '@/lib/post-resource-bundles';
import { formatBundleAccessLabel } from '@/lib/marketplace-trust';
import { buildShowcaseDetailPath } from '@/lib/share';
import { CURATED_SOURCE_TOOLS } from '@/lib/source-tools';

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

    const toolLabel = item.sourceTool ?? item.model;
    const creatorLabel = item.creator.name;
    const metadata = [
        toolLabel ? `Made with ${toolLabel}` : null,
        `${item.category === 'text' ? 'Tip' : item.category} by ${creatorLabel}`,
    ].filter(Boolean);

    if (item.asset) {
        const kinds = getItemResourceKinds(item);
        const unlockSummary = kinds.length > 0
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
    if (asset.priceQuote) {
        return formatBundleAccessLabel({
            accessMode: asset.accessMode,
            priceQuote: asset.priceQuote,
        });
    }

    return getBundleAccessLabel(asset.accessMode, asset.priceUsdCents);
}

export default function ShowcaseClient({
    initialFeed,
    initialCategory,
    initialSort,
    initialTool,
    initialUnlock,
    initialResource,
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
    const [selectedItem, setSelectedItem] = useState<ShowcaseFeedItem | null>(null);
    const previewVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

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

    useEffect(() => {
        setItems(initialFeed.items);
        setPageInfo(initialFeed.pageInfo);
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

    const loadMore = async () => {
        if (isLoadingMore || !pageInfo.hasMore || pageInfo.nextOffset === null) {
            return;
        }

        setIsLoadingMore(true);

        try {
            const params = new URLSearchParams({
                category,
                sort,
                tool,
                unlock,
                resource,
                offset: String(pageInfo.nextOffset),
                limit: String(SHOWCASE_PAGE_SIZE),
            });

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
            setIsLoadingMore(false);
        }
    };

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

    const openPreview = (item: ShowcaseFeedItem) => {
        setSelectedItem(item);
    };

    const closePreview = () => {
        setSelectedItem(null);
    };

    const activeFilterPills = [
        tool !== 'all' ? {
            key: 'tool',
            label: CURATED_SOURCE_TOOLS.find((option) => option.slug === tool)?.label ?? tool,
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

    const isLoadingInitialFeed = isPending && items.length === 0 && !isAuthLoading;

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

                  <AnimatePresence initial={false}>
                    {isFilterPanelOpen ? (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                        >
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
                                        {CURATED_SOURCE_TOOLS.map((option) => (
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
                        </motion.div>
                    ) : null}
                  </AnimatePresence>
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
                        <AnimatePresence>
                            {items.map((item, index) => (
                                <motion.div
                                    key={item.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: index * 0.05 }}
                                    className="group relative bg-[#09090b] border border-white/[0.04] rounded-[1.5rem] overflow-hidden hover:border-purple-500/40 hover:shadow-[0_8px_30px_rgba(0,0,0,0.3)] transition-all break-inside-avoid mb-6"
                                >
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
                                                className="rounded-none border-0 border-b border-white/8 shadow-none"
                                            />
                                        ) : item.mediaKind === 'video' && item.mediaUrl ? (
                                            <video
                                                ref={(node) => registerPreviewVideo(item.id, node)}
                                                src={item.mediaUrl}
                                                muted
                                                loop
                                                playsInline
                                                preload="metadata"
                                                className="w-full h-auto block object-cover transition-transform duration-500 group-hover:scale-105"
                                                onLoadedData={(event) => {
                                                    primePreviewVideoFrame(event.currentTarget);
                                                }}
                                                onMouseEnter={(event) => {
                                                    if (event.currentTarget.readyState === 0) {
                                                        event.currentTarget.load();
                                                    }
                                                    void event.currentTarget.play().catch(() => {});
                                                }}
                                                onMouseLeave={(event) => {
                                                    event.currentTarget.pause();
                                                    primePreviewVideoFrame(event.currentTarget);
                                                }}
                                            />
                                        ) : item.mediaUrl ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                                src={item.mediaUrl}
                                                alt={item.title}
                                                className="w-full h-auto block object-cover transition-transform duration-500 group-hover:scale-105"
                                            />
                                        ) : (
                                            <div className="flex min-h-[280px] items-center justify-center bg-zinc-950 text-zinc-500">
                                                <BookText className="h-10 w-10" />
                                            </div>
                                        )}

                                        {item.postFormat !== 'text' ? (
                                            <div className="absolute top-3 left-3 px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full text-xs font-medium border border-white/10 flex items-center gap-1.5">
                                                {item.category === 'video' ? <Video className="w-3.5 h-3.5" /> :
                                                    item.category === 'motion' ? <Users className="w-3.5 h-3.5" /> :
                                                        item.category === 'text' ? <BookText className="w-3.5 h-3.5" /> :
                                                            <ImageIcon className="w-3.5 h-3.5" />}
                                                <span className="capitalize">{item.category}</span>
                                            </div>
                                        ) : null}

                                        {item.postFormat !== 'text' && item.sourceKind === 'external' && item.sourceTool ? (
                                            <div className="absolute right-3 top-3 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-[11px] font-medium text-zinc-100 backdrop-blur-md">
                                                {item.sourceTool}
                                            </div>
                                        ) : null}

                                        {item.postFormat !== 'text' ? (
                                            <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                                <h3 className="font-medium text-white line-clamp-1">{item.title}</h3>
                                            </div>
                                        ) : null}
                                    </button>

                                    <div className="p-4 bg-zinc-900 border-t border-zinc-800">
                                        <div className="mb-4 flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                {(() => {
                                                    const resourceKinds = getItemResourceKinds(item);

                                                    return (
                                                        <>
                                                <h3 className="font-medium text-white line-clamp-1">{item.title}</h3>
                                                {item.asset ? (
                                                    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-100">
                                                        <ShoppingBag className="h-3.5 w-3.5" />
                                                        {getAssetAccessLabel(item.asset)}
                                                    </div>
                                                ) : null}
                                                {item.asset?.salesCount ? (
                                                    <div className="ml-2 mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-zinc-200">
                                                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-200" />
                                                        {formatUnlockCountLabel(item.asset.accessMode, item.asset.salesCount)}
                                                    </div>
                                                ) : null}
                                                {resourceKinds.length > 0 ? (
                                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                                        {resourceKinds.map((kind) => (
                                                            <span
                                                                key={`${item.id}-${kind}`}
                                                                className="rounded-full border border-white/10 bg-white/[0.035] px-2 py-1 text-[11px] font-medium text-zinc-300"
                                                            >
                                                                {getPostResourceKindLabel(kind)}
                                                            </span>
                                                        ))}
                                                    </div>
                                                ) : null}
                                                <div className="mt-3">
                                                    <CreatorIdentity creator={item.creator} compact />
                                                </div>
                                                <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-zinc-400">
                                                    {getItemSummary(item)}
                                                </p>
                                                        </>
                                                    );
                                                })()}
                                            </div>
                                            <span className="shrink-0 text-xs text-zinc-500">
                                                {new Date(item.createdAt).toLocaleDateString('en-US', {
                                                    month: 'short',
                                                    day: 'numeric',
                                                })}
                                            </span>
                                        </div>

                                        <div className="flex items-center justify-between gap-3">
                                            <button
                                                type="button"
                                                onClick={() => void toggleSave(item.id)}
                                                disabled={savingItemIds.has(item.id)}
                                                aria-pressed={savedItemIds.has(item.id)}
                                                aria-busy={savingItemIds.has(item.id)}
                                                aria-label={`${savedItemIds.has(item.id) ? 'Remove save from' : 'Save'} ${item.title}. ${item.saveCount} saves`}
                                                className="flex items-center gap-2 text-zinc-400 transition-colors hover:text-pink-400 disabled:cursor-not-allowed disabled:opacity-70"
                                            >
                                                <Heart className={`w-5 h-5 ${savedItemIds.has(item.id) ? 'fill-pink-500 text-pink-500' : ''}`} />
                                                <span className="text-sm font-medium">{item.saveCount}</span>
                                            </button>

                                            <div className="flex items-center gap-2">
                                                <PublicShareButton
                                                    generationId={item.id}
                                                    title={item.title}
                                                    description={item.body || item.prompt}
                                                    sourceSurface="showcase"
                                                    accessToken={session?.access_token ?? null}
                                                    className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08]"
                                                />
                                                {item.asset ? (
                                                    <Link
                                                        href={buildCommunityDetailPath(item.id, 'resources')}
                                                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                                                    >
                                                        <ShoppingBag className="h-4 w-4" />
                                                        View unlock
                                                    </Link>
                                                ) : null}
                                                {item.canRemix ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRemix(item.id)}
                                                        className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
                                                    >
                                                        <Wand2 className="w-4 h-4" />
                                                        Remix
                                                        <span className="bg-purple-800/50 px-1.5 py-0.5 rounded text-xs ml-1">{item.remixCount}</span>
                                                    </button>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    </div>
                )}

                {pageInfo.hasMore && !isLoadingInitialFeed && (
                    <div className="mt-12 text-center">
                        <button
                            type="button"
                            onClick={loadMore}
                            disabled={isLoadingMore}
                            className="px-6 py-3 bg-zinc-900 border border-zinc-700 rounded-xl text-sm font-medium hover:bg-zinc-800 hover:border-zinc-600 transition-all disabled:opacity-50"
                        >
                            {isLoadingMore ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : 'Load More'}
                        </button>
                    </div>
                )}
            </div>

            <MediaDetailsPreviewModal
                isOpen={Boolean(selectedItem)}
                onClose={closePreview}
                mediaType={
                    selectedItem
                        ? selectedItem.postFormat === 'text'
                            ? 'text'
                            : selectedItem.mediaKind === 'video'
                                ? 'video'
                                : 'image'
                        : 'image'
                }
                src={selectedItem?.mediaUrl ?? null}
                alt={selectedItem?.title ?? 'Selected showcase item'}
                title={selectedItem?.title ?? 'Showcase preview'}
                prompt={selectedItem?.prompt ?? ''}
                body={selectedItem?.body ?? ''}
                creator={selectedItem?.creator}
                actions={selectedItem ? (
                    <>
                        <PublicShareButton
                            generationId={selectedItem.id}
                            title={selectedItem.title}
                            description={selectedItem.body || selectedItem.prompt}
                            sourceSurface="showcase"
                            accessToken={session?.access_token ?? null}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                        />
                        {selectedItem.asset ? (
                            <Link
                                href={buildCommunityDetailPath(selectedItem.id, 'resources')}
                                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                            >
                                View unlock
                            </Link>
                        ) : null}
                        <Link
                            href={buildCommunityDetailPath(selectedItem.id)}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
                        >
                            Open page
                        </Link>
                        {selectedItem.canRemix ? (
                            <button
                                type="button"
                                onClick={() => handleRemix(selectedItem.id)}
                                className="inline-flex items-center gap-2 rounded-full bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-500"
                            >
                                <Wand2 className="h-4 w-4" />
                                Remix
                            </button>
                        ) : null}
                    </>
                ) : null}
            />
        </div>
    );
}
