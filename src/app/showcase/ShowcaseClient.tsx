'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, Heart, Wand2, Image as ImageIcon, Video, Layers, Users, TrendingUp, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/app/components/AuthProvider';
import CreatorIdentity from '@/app/components/CreatorIdentity';
import SkeletonLoader from '@/app/components/SkeletonLoader';
import {
    SHOWCASE_PAGE_SIZE,
    type ShowcaseCategory,
    type ShowcaseFeedItem,
    type ShowcaseFeedPage,
    type ShowcaseSort,
} from '@/lib/showcase';

const CATEGORIES: Array<{
    id: ShowcaseCategory;
    label: string;
    icon: typeof Layers;
}> = [
    { id: 'all', label: 'All', icon: Layers },
    { id: 'image', label: 'Images', icon: ImageIcon },
    { id: 'video', label: 'Videos', icon: Video },
    { id: 'motion', label: 'Motion', icon: Users },
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
    const [savedGenerationIds, setSavedGenerationIds] = useState<Set<string>>(new Set());
    const [selectedItem, setSelectedItem] = useState<ShowcaseFeedItem | null>(null);
    const previewVideoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
    const itemIdsKey = items.map((item) => item.id).join(',');

    const registerPreviewVideo = (id: string, node: HTMLVideoElement | null) => {
        previewVideoRefs.current[id] = node;
    };

    useEffect(() => {
        setItems(initialFeed.items);
        setPageInfo(initialFeed.pageInfo);
        setCategory(initialCategory);
        setSort(initialSort);
    }, [initialCategory, initialFeed, initialSort]);

    useEffect(() => {
        let isActive = true;

        const fetchSavedState = async () => {
            if (isAuthLoading) {
                return;
            }

            if (!session?.access_token || itemIdsKey.length === 0) {
                if (isActive) {
                    setSavedGenerationIds(new Set());
                }
                return;
            }

            try {
                const params = new URLSearchParams({
                    ids: itemIdsKey,
                });

                const response = await fetch(`/api/showcase/saved-state?${params.toString()}`, {
                    headers: {
                        Authorization: `Bearer ${session.access_token}`,
                    },
                });

                if (!response.ok) {
                    throw new Error(`Saved-state request failed with ${response.status}`);
                }

                const generationIds: string[] = await response.json();
                if (isActive) {
                    setSavedGenerationIds(new Set(generationIds));
                }
            } catch (error) {
                console.error('Failed to load showcase saved state:', error);
            }
        };

        void fetchSavedState();

        return () => {
            isActive = false;
        };
    }, [isAuthLoading, itemIdsKey, session?.access_token]);

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

            const response = await fetch(`/api/showcase/feed?${params.toString()}`);
            if (!response.ok) {
                throw new Error(`Feed request failed with ${response.status}`);
            }

            const nextFeed: ShowcaseFeedPage = await response.json();

            setItems((currentItems) => [
                ...currentItems,
                ...nextFeed.items.filter((item) => !currentItems.some((current) => current.id === item.id)),
            ]);
            setPageInfo(nextFeed.pageInfo);
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

    const isLoadingInitialFeed = isPending && items.length === 0;

    return (
        <div className="min-h-screen bg-black text-white p-6 sm:p-8 font-[family-name:var(--font-geist-sans)]">
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(120,0,255,0.05),transparent_50%)]" />
            </div>

            <div className="max-w-7xl mx-auto relative z-10 pt-20">
                <div className="mb-12">
                    <h1 className="text-4xl sm:text-5xl font-bold mb-4 tracking-tight flex items-center gap-4">
                        <TrendingUp className="w-10 h-10 text-purple-400" />
                        Community Showcase
                    </h1>
                    <p className="text-zinc-400 text-lg max-w-2xl">
                        Discover, save, and remix top-performing AI generations from the community.
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((placeholder) => (
                            <SkeletonLoader key={placeholder} className="aspect-[4/5]" />
                        ))}
                    </div>
                ) : items.length === 0 ? (
                    <div className="text-center py-24 text-zinc-500 bg-zinc-900/20 rounded-2xl border border-zinc-800">
                        <ImageIcon className="w-12 h-12 mx-auto mb-4 opacity-20" />
                        <p className="text-lg">No creations found in this category.</p>
                        <p className="text-sm mt-2">Be the first to publish one!</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        <AnimatePresence>
                            {items.map((item, index) => (
                                <motion.div
                                    key={item.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: index * 0.05 }}
                                    className="group relative bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-purple-500/50 transition-colors"
                                >
                                    <button
                                        type="button"
                                        onClick={() => openPreview(item)}
                                        className="aspect-[4/5] relative bg-black overflow-hidden block w-full text-left"
                                    >
                                        {item.category === 'video' || item.category === 'motion' ? (
                                            <video
                                                ref={(node) => registerPreviewVideo(item.id, node)}
                                                src={item.url}
                                                muted
                                                loop
                                                playsInline
                                                preload="metadata"
                                                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
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
                                        ) : (
                                            <Image
                                                src={item.url}
                                                alt={item.title}
                                                fill
                                                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, (max-width: 1536px) 33vw, 25vw"
                                                className="object-cover transition-transform duration-500 group-hover:scale-105"
                                            />
                                        )}

                                        <div className="absolute top-3 left-3 px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full text-xs font-medium border border-white/10 flex items-center gap-1.5">
                                            {item.category === 'video' ? <Video className="w-3.5 h-3.5" /> :
                                                item.category === 'motion' ? <Users className="w-3.5 h-3.5" /> :
                                                    <ImageIcon className="w-3.5 h-3.5" />}
                                            <span className="capitalize">{item.category}</span>
                                        </div>

                                        <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                            <h3 className="font-medium text-white line-clamp-1">{item.title}</h3>
                                        </div>
                                    </button>

                                    <div className="p-4 bg-zinc-900 border-t border-zinc-800">
                                        <div className="mb-4 flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <h3 className="font-medium text-white line-clamp-1">{item.title}</h3>
                                                <div className="mt-3">
                                                    <CreatorIdentity creator={item.creator} compact />
                                                </div>
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

                                            <button
                                                type="button"
                                                onClick={() => handleRemix(item.id)}
                                                className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
                                            >
                                                <Wand2 className="w-4 h-4" />
                                                Remix
                                                <span className="bg-purple-800/50 px-1.5 py-0.5 rounded text-xs ml-1">{item.remixCount}</span>
                                            </button>
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

            <AnimatePresence>
                {selectedItem && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                        onClick={closePreview}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0, y: 20 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.95, opacity: 0, y: 20 }}
                            onClick={(event) => event.stopPropagation()}
                            className="bg-zinc-900 border border-white/10 p-6 rounded-3xl max-w-3xl w-full flex flex-col gap-6 shadow-2xl relative"
                        >
                            <button
                                type="button"
                                onClick={closePreview}
                                className="absolute top-4 right-4 p-2 z-10 bg-black/50 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>

                            <div className="pr-12">
                                <h2 className="text-xl font-bold bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">
                                    {selectedItem.title}
                                </h2>
                                <div className="mt-4">
                                    <CreatorIdentity creator={selectedItem.creator} />
                                </div>
                            </div>

                            <div className="rounded-xl overflow-hidden border border-white/5 bg-black/50 flex items-center justify-center flex-1 min-h-[300px]">
                                {selectedItem.category === 'video' || selectedItem.category === 'motion' ? (
                                    <video
                                        src={selectedItem.url}
                                        controls
                                        autoPlay
                                        loop
                                        playsInline
                                        preload="metadata"
                                        className="max-h-[60vh] object-contain rounded-xl w-full"
                                    />
                                ) : (
                                    <div className="relative w-full min-h-[300px] max-h-[60vh] aspect-[4/5]">
                                        <Image
                                            src={selectedItem.url}
                                            alt={selectedItem.title}
                                            fill
                                            sizes="90vw"
                                            className="object-contain rounded-xl"
                                        />
                                    </div>
                                )}
                            </div>

                            <div className="bg-black/40 p-4 rounded-2xl border border-white/5 flex flex-col gap-2">
                                <div className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Prompt</div>
                                <p className="text-sm text-zinc-300 leading-relaxed max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                                    {selectedItem.prompt || 'No prompt available'}
                                </p>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
