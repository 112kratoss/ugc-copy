'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, Heart, Wand2, Image as ImageIcon, Video, Layers, Users, TrendingUp, ShoppingBag, BookText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/app/components/AuthProvider';
import CreatorIdentity from '@/app/components/CreatorIdentity';
import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';
import PublicShareButton from '@/app/components/PublicShareButton';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import {
    SHOWCASE_PAGE_SIZE,
    type ShowcaseCategory,
    type ShowcaseFeedItem,
    type ShowcaseFeedPage,
    type ShowcaseSort,
} from '@/lib/showcase';
import { buildShowcaseDetailPath } from '@/lib/share';

const CATEGORIES: Array<{
    id: ShowcaseCategory;
    label: string;
    icon: typeof Layers;
}> = [
    { id: 'all', label: 'All', icon: Layers },
    { id: 'image', label: 'Images', icon: ImageIcon },
    { id: 'video', label: 'Videos', icon: Video },
    { id: 'motion', label: 'Motion', icon: Users },
    { id: 'text', label: 'Text', icon: BookText },
];

const SORTS: Array<{ id: ShowcaseSort; label: string }> = [
    { id: 'recent', label: 'Recent' },
    { id: 'top-saves', label: 'Most Saved' },
    { id: 'top-remixes', label: 'Most Remixed' },
];

interface ShowcaseClientProps {
    initialFeed: ShowcaseFeedPage;
    initialCategory: ShowcaseCategory;
    initialSort: ShowcaseSort;
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

    return item.postFormat === 'text'
        ? 'No note content added yet.'
        : 'No prompt captured for this post yet.';
}

export default function ShowcaseClient({
    initialFeed,
    initialCategory,
    initialSort,
}: ShowcaseClientProps) {
    const router = useRouter();
    const pathname = usePathname();
    const { session, user, isLoading: isAuthLoading } = useAuth();
    const [isPending, startTransition] = useTransition();
    const [items, setItems] = useState(initialFeed.items);
    const [category, setCategory] = useState(initialCategory);
    const [sort, setSort] = useState(initialSort);
    const [pageInfo, setPageInfo] = useState(initialFeed.pageInfo);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [savedGenerationIds, setSavedGenerationIds] = useState<Set<string>>(
        new Set(initialFeed.items.filter((item) => item.isSaved).map((item) => item.id))
    );
    const [selectedItem, setSelectedItem] = useState<ShowcaseFeedItem | null>(null);
    const previewVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

    const registerPreviewVideo = (id: string, node: HTMLVideoElement | null) => {
        previewVideoRefs.current[id] = node;
    };

    useEffect(() => {
        setItems(initialFeed.items);
        setPageInfo(initialFeed.pageInfo);
        setCategory(initialCategory);
        setSort(initialSort);
        setSavedGenerationIds(new Set(initialFeed.items.filter((item) => item.isSaved).map((item) => item.id)));
    }, [initialCategory, initialFeed, initialSort]);

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

    const navigateWithFilters = (nextCategory: ShowcaseCategory, nextSort: ShowcaseSort) => {
        const params = new URLSearchParams();

        if (nextCategory !== 'all') {
            params.set('category', nextCategory);
        }

        if (nextSort !== 'recent') {
            params.set('sort', nextSort);
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
            setSavedGenerationIds((currentSavedIds) => {
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

    const handleSave = async (id: string) => {
        if (!user || !session?.access_token) {
            router.push('/login?returnUrl=/showcase');
            return;
        }

        const currentlySaved = savedGenerationIds.has(id);

        setSavedGenerationIds((previous) => {
            const next = new Set(previous);
            if (currentlySaved) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });

        setItems((previous) =>
            previous.map((item) => {
                if (item.id !== id) {
                    return item;
                }

                return {
                    ...item,
                    saveCount: Math.max(0, item.saveCount + (currentlySaved ? -1 : 1)),
                };
            })
        );

        try {
            const response = await fetch('/api/showcase/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ generationId: id }),
            });

            const data = await response.json();
            if (!response.ok || !data.success) {
                throw new Error(data.error || 'Failed to save showcase item');
            }
        } catch (error) {
            console.error('Save failed:', error);

            setSavedGenerationIds((previous) => {
                const next = new Set(previous);
                if (currentlySaved) {
                    next.add(id);
                } else {
                    next.delete(id);
                }
                return next;
            });

            setItems((previous) =>
                previous.map((item) => {
                    if (item.id !== id) {
                        return item;
                    }

                    return {
                        ...item,
                        saveCount: Math.max(0, item.saveCount + (currentlySaved ? 1 : -1)),
                    };
                })
            );
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

    const isLoadingInitialFeed = isPending && items.length === 0 && !isAuthLoading;

    return (
        <div className="min-h-screen bg-black py-6 text-white sm:py-8 font-[family-name:var(--font-geist-sans)]">
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(120,0,255,0.05),transparent_50%)]" />
            </div>

            <div className="studio-shell relative z-10 pt-20">
                <div className="mb-12">
                    <h1 className="text-4xl sm:text-5xl font-bold mb-4 tracking-tight flex items-center gap-4">
                        <TrendingUp className="w-10 h-10 text-purple-400" />
                        Community Feed
                    </h1>
                    <p className="text-zinc-400 text-lg max-w-2xl">
                        Discover creator posts, external uploads, and paid workflows, guides, and prompt packs behind the work.
                    </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center mb-8">
                    <div className="flex gap-2 overflow-x-auto pb-2 sm:pb-0 w-full sm:w-auto hide-scrollbar">
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
                    <div className="flex gap-2 w-full sm:w-auto">
                        {SORTS.map((sortOption) => (
                            <button
                                key={sortOption.id}
                                type="button"
                                onClick={() => {
                                    setSort(sortOption.id);
                                    navigateWithFilters(category, sortOption.id);
                                }}
                                disabled={isPending}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-70
                                    ${sort === sortOption.id
                                        ? 'bg-zinc-800 text-white'
                                        : 'text-zinc-500 hover:text-white hover:bg-zinc-800/50'
                                    }`}
                            >
                                {sortOption.label}
                            </button>
                        ))}
                    </div>
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
                        <p className="text-lg">No creations found in this category.</p>
                        <p className="text-sm mt-2">Be the first to publish one!</p>
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
                                            <div className="min-h-[280px] bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.16),transparent_36%),linear-gradient(180deg,rgba(10,10,14,1),rgba(7,7,10,1))] p-6">
                                                <div className="rounded-[1.4rem] border border-white/8 bg-zinc-950/80 p-5 shadow-[0_20px_50px_rgba(0,0,0,0.3)]">
                                                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Tip / Note</div>
                                                    <p className="mt-4 line-clamp-8 whitespace-pre-wrap text-sm leading-7 text-zinc-100">
                                                        {getItemSummary(item)}
                                                    </p>
                                                </div>
                                            </div>
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

                                        <div className="absolute top-3 left-3 px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full text-xs font-medium border border-white/10 flex items-center gap-1.5">
                                            {item.category === 'video' ? <Video className="w-3.5 h-3.5" /> :
                                                item.category === 'motion' ? <Users className="w-3.5 h-3.5" /> :
                                                    item.category === 'text' ? <BookText className="w-3.5 h-3.5" /> :
                                                        <ImageIcon className="w-3.5 h-3.5" />}
                                            <span className="capitalize">{item.category}</span>
                                        </div>

                                        {item.sourceKind === 'external' && item.sourceTool ? (
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
                                                <h3 className="font-medium text-white line-clamp-1">{item.title}</h3>
                                                {item.asset ? (
                                                    <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-100">
                                                        <ShoppingBag className="h-3.5 w-3.5" />
                                                        {item.asset.type === 'prompt_pack' ? 'Prompt Pack' : item.asset.type === 'guide' ? 'Guide' : 'Workflow'}
                                                    </div>
                                                ) : null}
                                                <div className="mt-3">
                                                    <CreatorIdentity creator={item.creator} compact />
                                                </div>
                                                <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-zinc-400">
                                                    {getItemSummary(item)}
                                                </p>
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
                                                onClick={() => handleSave(item.id)}
                                                className="flex items-center gap-2 text-zinc-400 hover:text-pink-400 transition-colors"
                                            >
                                                <Heart className={`w-5 h-5 ${savedGenerationIds.has(item.id) ? 'fill-pink-500 text-pink-500' : ''}`} />
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
                                href={`/marketplace/${selectedItem.asset.id}`}
                                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:border-emerald-300/40 hover:bg-emerald-500/15"
                            >
                                View resource
                            </Link>
                        ) : null}
                        <Link
                            href={buildShowcaseDetailPath(selectedItem.id)}
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
