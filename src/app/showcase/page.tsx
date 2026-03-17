'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { Loader2, Heart, Wand2, Image as ImageIcon, Video, Layers, Users, TrendingUp, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// --- Types ---
interface Creator {
    id: string;
    name: string;
    avatar: string | null;
}

interface FeedItem {
    id: string;
    url: string;
    model: string;
    title: string;
    prompt: string;
    category: string;
    saveCount: number;
    remixCount: number;
    createdAt: string;
    creator: Creator;
    hasSaved: boolean;
}

const CATEGORIES = [
    { id: 'all', label: 'All', icon: Layers },
    { id: 'image', label: 'Images', icon: ImageIcon },
    { id: 'video', label: 'Videos', icon: Video },
    { id: 'motion', label: 'Motion', icon: Users },
];

const SORTS = [
    { id: 'recent', label: 'Recent' },
    { id: 'top-saves', label: 'Most Saved' },
    { id: 'top-remixes', label: 'Most Remixed' },
];

export default function ShowcasePage() {
    const router = useRouter();
    const [items, setItems] = useState<FeedItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [category, setCategory] = useState('all');
    const [sort, setSort] = useState('recent');
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(true);
    const [user, setUser] = useState<User | null>(null);
    const [selectedItem, setSelectedItem] = useState<FeedItem | null>(null);

    // Initial auth check
    useEffect(() => {
        supabase.auth.getUser().then(({ data }) => {
            setUser(data.user);
        });
    }, []);

    const fetchFeed = useCallback(async (pageNum: number, currentItems: FeedItem[] = []) => {
        try {
            if (pageNum === 1) setIsLoading(true);
            else setIsLoadingMore(true);

            const { data: { session } } = await supabase.auth.getSession();
            const headers: Record<string, string> = {};
            if (session) headers['Authorization'] = `Bearer ${session.access_token}`;

            const res = await fetch(`/api/showcase/feed?category=${category}&sort=${sort}&page=${pageNum}&limit=12`, {
                headers
            });
            const data = await res.json();

            if (data.items) {
                setItems(pageNum === 1 ? data.items : [...currentItems, ...data.items]);
                setHasMore(data.pagination.hasMore);
            }
        } catch (error) {
            console.error('Failed to fetch feed:', error);
        } finally {
            setIsLoading(false);
            setIsLoadingMore(false);
        }
    }, [category, sort]);

    // Initial load and filter changes
    useEffect(() => {
        setPage(1);
        fetchFeed(1);
    }, [fetchFeed]);

    const loadMore = () => {
        if (!isLoadingMore && hasMore) {
            const nextPage = page + 1;
            setPage(nextPage);
            fetchFeed(nextPage, items);
        }
    };

    const handleSave = async (id: string, currentSavedState: boolean) => {
        if (!user) {
            router.push('/login?returnUrl=/showcase');
            return;
        }

        const applySavedState = (savedState: boolean) => {
            setItems(prev => prev.map(item => {
                if (item.id !== id) {
                    return item;
                }

                const countDelta =
                    item.hasSaved === savedState ? 0 : savedState ? 1 : -1;

                return {
                    ...item,
                    hasSaved: savedState,
                    saveCount: Math.max(0, item.saveCount + countDelta)
                };
            }));
        };

        applySavedState(!currentSavedState);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch('/api/showcase/save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({ generationId: id })
            });
            const data = await res.json();

            if (!data.success) {
                applySavedState(currentSavedState);
            }
        } catch (error) {
            console.error('Save failed:', error);
            applySavedState(currentSavedState);
        }
    };

    const handleRemix = async (id: string) => {
        if (!user) {
            router.push('/login?returnUrl=/showcase');
            return;
        }

        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch('/api/showcase/remix', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({ generationId: id })
            });
            const data = await res.json();

            if (data.success && data.redirectTo) {
                router.push(data.redirectTo);
            }
        } catch (error) {
            console.error('Remix failed:', error);
        }
    };

    const openPreview = (item: FeedItem) => {
        setSelectedItem(item);
    };

    const closePreview = () => {
        setSelectedItem(null);
    };

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

                {/* Filters & Sorting */}
                <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center mb-8">
                    <div className="flex gap-2 overflow-x-auto pb-2 sm:pb-0 w-full sm:w-auto hide-scrollbar">
                        {CATEGORIES.map((cat) => {
                            const Icon = cat.icon;
                            return (
                                <button
                                    key={cat.id}
                                    onClick={() => setCategory(cat.id)}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors whitespace-nowrap
                                        ${category === cat.id 
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
                        {SORTS.map((s) => (
                            <button
                                key={s.id}
                                onClick={() => setSort(s.id)}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
                                    ${sort === s.id 
                                        ? 'bg-zinc-800 text-white' 
                                        : 'text-zinc-500 hover:text-white hover:bg-zinc-800/50'
                                    }`}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Grid */}
                {isLoading ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                            <div key={i} className="aspect-[4/5] bg-zinc-900/50 rounded-2xl animate-pulse" />
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
                            {items.map((item, i) => (
                                <motion.div
                                    key={item.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: i * 0.05 }}
                                    className="group relative bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-purple-500/50 transition-colors"
                                >
                                    {/* Media */}
                                    <button
                                        type="button"
                                        onClick={() => openPreview(item)}
                                        className="aspect-[4/5] relative bg-black overflow-hidden block w-full text-left"
                                    >
                                        {item.category === 'video' || item.category === 'motion' ? (
                                            <video 
                                                src={item.url} 
                                                muted 
                                                loop 
                                                playsInline
                                                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                                                onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                                                onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }}
                                            />
                                        ) : (
                                            /* eslint-disable-next-line @next/next/no-img-element */
                                            <img 
                                                src={item.url} 
                                                alt={item.title} 
                                                loading="lazy"
                                                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" 
                                            />
                                        )}

                                        {/* Category Badge */}
                                        <div className="absolute top-3 left-3 px-2.5 py-1 bg-black/60 backdrop-blur-md rounded-full text-xs font-medium border border-white/10 flex items-center gap-1.5">
                                            {item.category === 'video' ? <Video className="w-3.5 h-3.5" /> : 
                                             item.category === 'motion' ? <Users className="w-3.5 h-3.5" /> : 
                                             <ImageIcon className="w-3.5 h-3.5" />}
                                            <span className="capitalize">{item.category}</span>
                                        </div>

                                        {/* Hover Overlay Actions */}
                                        <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-end justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                                            <div>
                                                <h3 className="font-medium text-white line-clamp-1">{item.title}</h3>
                                                <p className="text-xs text-zinc-300 mt-1">by {item.creator.name}</p>
                                            </div>
                                        </div>
                                    </button>

                                    {/* Action Bar */}
                                    <div className="p-4 bg-zinc-900 border-t border-zinc-800 flex items-center justify-between">
                                        <button 
                                            onClick={() => handleSave(item.id, item.hasSaved)}
                                            className="flex items-center gap-2 text-zinc-400 hover:text-pink-400 transition-colors"
                                        >
                                            <Heart className={`w-5 h-5 ${item.hasSaved ? 'fill-pink-500 text-pink-500' : ''}`} />
                                            <span className="text-sm font-medium">{item.saveCount}</span>
                                        </button>

                                        <button 
                                            onClick={() => handleRemix(item.id)}
                                            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
                                        >
                                            <Wand2 className="w-4 h-4" />
                                            Remix
                                            <span className="bg-purple-800/50 px-1.5 py-0.5 rounded text-xs ml-1">{item.remixCount}</span>
                                        </button>
                                    </div>
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    </div>
                )}

                {hasMore && !isLoading && (
                    <div className="mt-12 text-center">
                        <button
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
                            onClick={(e) => e.stopPropagation()}
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
                                <p className="mt-1 text-sm text-zinc-400">
                                    by {selectedItem.creator.name}
                                </p>
                            </div>

                            <div className="rounded-xl overflow-hidden border border-white/5 bg-black/50 flex items-center justify-center flex-1 min-h-[300px]">
                                {selectedItem.category === 'video' || selectedItem.category === 'motion' ? (
                                    <video
                                        src={selectedItem.url}
                                        controls
                                        autoPlay
                                        loop
                                        className="max-h-[60vh] object-contain rounded-xl w-full"
                                    />
                                ) : (
                                    /* eslint-disable-next-line @next/next/no-img-element */
                                    <img
                                        src={selectedItem.url}
                                        alt={selectedItem.title}
                                        className="max-h-[60vh] object-contain rounded-xl"
                                    />
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
