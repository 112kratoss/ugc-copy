'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Clock, Zap, Film, Loader2, Globe, CheckCircle2, X, Volume2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { isAudioModel, isImageModel } from '@/lib/models';
import { supabase } from '@/lib/supabase';

interface Generation {
    id: string;
    output_url: string | null;
    status: string;
    created_at: string;
    duration: number | null;
    cost: number | null;
    model: string;
    category?: string | null;
    is_public?: boolean;
}

type FilterType = 'all' | 'images' | 'videos' | 'audio';

export default function CreationsPage() {
    const router = useRouter();
    const [generations, setGenerations] = useState<Generation[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [filter, setFilter] = useState<FilterType>('all');

    // Publish Modal State
    const [publishModalOpen, setPublishModalOpen] = useState(false);
    const [selectedGen, setSelectedGen] = useState<Generation | null>(null);
    const [publishTitle, setPublishTitle] = useState('');
    const [publishDesc, setPublishDesc] = useState('');
    const [isPublishing, setIsPublishing] = useState(false);

    useEffect(() => {
        const fetchCreations = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                router.push('/login');
                return;
            }

            try {
                const res = await fetch('/api/generations', {
                    headers: { 'Authorization': `Bearer ${session.access_token}` },
                });
                const data = await res.json();
                if (res.ok) setGenerations(data.generations || []);
            } catch (err) {
                console.error('Failed to fetch creations:', err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchCreations();
    }, [router]);

    const handlePublishSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedGen) return;

        setIsPublishing(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch('/api/showcase/publish', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({
                    generationId: selectedGen.id,
                    isPublic: true,
                    title: publishTitle.trim() || undefined,
                    description: publishDesc.trim() || undefined,
                })
            });

            const data = await res.json();
            if (data.success) {
                // Optimistically update the local list
                setGenerations(prev => prev.map(g => g.id === selectedGen.id ? { ...g, is_public: true } : g));
                setPublishModalOpen(false);
            } else {
                alert(data.error || 'Failed to publish');
            }
        } catch (err) {
            console.error(err);
            alert('Failed to publish');
        } finally {
            setIsPublishing(false);
        }
    };

    const handleUnpublish = async (generationId: string) => {
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch('/api/showcase/publish', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session?.access_token}`
                },
                body: JSON.stringify({
                    generationId,
                    isPublic: false
                })
            });

            const data = await res.json();
            if (data.success) {
                setGenerations(prev => prev.map(g => g.id === generationId ? { ...g, is_public: false } : g));
            }
        } catch (err) {
            console.error(err);
        }
    };

    const formatDate = (dateStr: string) =>
        new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });

    const getGenerationCategory = (generation: Generation): 'image' | 'video' | 'audio' | 'motion' | 'ugc-ad' => {
        if (generation.category === 'audio' || generation.category === 'image' || generation.category === 'motion' || generation.category === 'ugc-ad') {
            return generation.category;
        }

        if (generation.category === 'video') {
            return 'video';
        }

        if (isImageModel(generation.model)) {
            return 'image';
        }

        if (isAudioModel(generation.model)) {
            return 'audio';
        }

        return 'video';
    };

    const getMediaKind = (generation: Generation): 'image' | 'video' | 'audio' => {
        const category = getGenerationCategory(generation);
        if (category === 'image') return 'image';
        if (category === 'audio') return 'audio';
        return 'video';
    };

    const inferDownloadExtension = (generation: Generation): string => {
        const mediaKind = getMediaKind(generation);
        const fallback = mediaKind === 'image' ? 'jpg' : mediaKind === 'audio' ? 'mp3' : 'mp4';
        if (!generation.output_url) return fallback;

        try {
            const pathname = new URL(generation.output_url, 'http://localhost').pathname;
            const extension = pathname.split('.').pop();
            return extension && extension.length <= 5 ? extension : fallback;
        } catch {
            return fallback;
        }
    };

    const successfulGenerations = generations.filter(g => g.status === 'succeeded' && g.output_url);
    const processingGenerations = generations.filter(g => g.status === 'processing');
    const failedGenerations = generations.filter(g => g.status === 'failed');

    const filteredSuccessful = successfulGenerations.filter(g => {
        const mediaKind = getMediaKind(g);
        if (filter === 'images') return mediaKind === 'image';
        if (filter === 'videos') return mediaKind === 'video';
        if (filter === 'audio') return mediaKind === 'audio';
        return true;
    });

    const imageCount = successfulGenerations.filter(g => getMediaKind(g) === 'image').length;
    const videoCount = successfulGenerations.filter(g => getMediaKind(g) === 'video').length;
    const audioCount = successfulGenerations.filter(g => getMediaKind(g) === 'audio').length;

    return (
        <div className="min-h-screen bg-black text-white">
            {/* Background effects */}
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-purple-900/15 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-pink-900/10 blur-[120px] rounded-full mix-blend-screen" />
            </div>

            <div className="relative z-10 max-w-7xl mx-auto px-6 py-8">
                {/* Header */}
                <div className="flex items-center gap-4 mb-8">
                    <Link href="/" className="group p-3 rounded-full bg-zinc-900/50 border border-white/5 hover:bg-zinc-800 hover:border-white/10 transition-all backdrop-blur-md">
                        <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">
                            My Creations
                        </h1>
                        <p className="text-sm text-zinc-500 font-medium tracking-wide">
                            {successfulGenerations.length} CREATION{successfulGenerations.length !== 1 ? 'S' : ''} TOTAL
                        </p>
                    </div>
                </div>

                {/* Filter Tabs */}
                {!isLoading && successfulGenerations.length > 0 && (
                    <div className="flex gap-2 mb-8">
                        {([
                            { key: 'all', label: `All (${successfulGenerations.length})` },
                            { key: 'images', label: `🖼 Images (${imageCount})` },
                            { key: 'videos', label: `🎬 Videos (${videoCount})` },
                            { key: 'audio', label: `🔊 Audio (${audioCount})` },
                        ] as { key: FilterType; label: string }[]).map(tab => (
                            <button
                                key={tab.key}
                                onClick={() => setFilter(tab.key)}
                                className={`px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200 ${filter === tab.key
                                    ? 'bg-white/10 text-white border border-white/20'
                                    : 'bg-zinc-900/50 text-zinc-500 border border-white/5 hover:text-zinc-300 hover:bg-zinc-800'
                                    }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                )}

                {/* Loading */}
                {isLoading && (
                    <div className="flex flex-col items-center justify-center py-32 gap-4">
                        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                        <p className="text-zinc-500 text-sm">Loading your creations...</p>
                    </div>
                )}

                {/* Empty State */}
                {!isLoading && generations.length === 0 && (
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col items-center justify-center py-32 gap-6">
                        <div className="p-6 rounded-full bg-zinc-900/50 border border-white/5">
                            <Film className="w-12 h-12 text-zinc-600" />
                        </div>
                        <div className="text-center">
                            <h2 className="text-xl font-semibold text-zinc-300 mb-2">No creations yet</h2>
                            <p className="text-zinc-500 text-sm max-w-md">
                                You haven&apos;t generated anything yet. Start by creating a motion control video or an AI image.
                            </p>
                        </div>
                        <div className="flex gap-3">
                            <Link href="/create" className="group relative overflow-hidden rounded-full p-[1px] bg-gradient-to-r from-purple-500 to-pink-500 hover:shadow-[0_0_30px_-5px_rgba(168,85,247,0.5)] transition-all duration-300 hover:scale-105">
                                <div className="flex items-center justify-center gap-2 bg-zinc-950 px-6 py-3 rounded-full">
                                    <span className="font-semibold text-white text-sm">🎬 Motion Control</span>
                                </div>
                            </Link>
                            <Link href="/create-image" className="group relative overflow-hidden rounded-full p-[1px] bg-gradient-to-r from-blue-500 to-cyan-500 hover:shadow-[0_0_30px_-5px_rgba(59,130,246,0.5)] transition-all duration-300 hover:scale-105">
                                <div className="flex items-center justify-center gap-2 bg-zinc-950 px-6 py-3 rounded-full">
                                    <span className="font-semibold text-white text-sm">🖼 Generate Image</span>
                                </div>
                            </Link>
                        </div>
                    </motion.div>
                )}

                {/* Processing */}
                {processingGenerations.length > 0 && (
                    <div className="mb-10">
                        <h2 className="text-xs font-bold text-yellow-400/80 uppercase tracking-widest mb-4 flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" /> Processing ({processingGenerations.length})
                        </h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            {processingGenerations.map((gen, i) => (
                                <motion.div key={gen.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                                    className="bg-zinc-900/30 rounded-2xl border border-yellow-500/20 overflow-hidden backdrop-blur-sm">
                                    <div className="aspect-video bg-black/60 flex items-center justify-center">
                                        <div className="flex flex-col items-center gap-3">
                                            <Loader2 className="w-8 h-8 text-yellow-400 animate-spin" />
                                            <span className="text-xs text-zinc-500">Generating...</span>
                                        </div>
                                    </div>
                                    <div className="p-4"><p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p></div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Successful Creations */}
                {filteredSuccessful.length > 0 && (
                    <div className="mb-10">
                        {processingGenerations.length > 0 && (
                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Completed</h2>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            {filteredSuccessful.map((gen, i) => {
                                const mediaKind = getMediaKind(gen);
                                const isImage = mediaKind === 'image';
                                const isAudio = mediaKind === 'audio';
                                const badgeClass = isImage
                                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                                    : isAudio
                                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                        : 'bg-purple-500/20 text-purple-300 border border-purple-500/30';
                                const badgeLabel = isImage ? '🖼 Image' : isAudio ? '🔊 Audio' : '🎬 Video';
                                return (
                                    <motion.div key={gen.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                                        className="group bg-zinc-900/30 rounded-2xl border border-white/5 overflow-hidden backdrop-blur-sm hover:border-purple-500/30 hover:shadow-[0_0_30px_-10px_rgba(168,85,247,0.2)] transition-all duration-300">
                                        <div className="bg-black relative overflow-hidden rounded-t-2xl">
                                            {isImage ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={gen.output_url!} alt="Generated image" className="w-full h-auto block" />
                                            ) : isAudio ? (
                                                <div className="p-6">
                                                    <div className="mb-4 flex items-center gap-3 text-emerald-300">
                                                        <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 p-3">
                                                            <Volume2 className="w-5 h-5" />
                                                        </div>
                                                        <div>
                                                            <div className="text-sm font-semibold text-white">Audio generation</div>
                                                            <div className="text-xs text-zinc-500">{gen.model}</div>
                                                        </div>
                                                    </div>
                                                    <audio src={gen.output_url!} className="w-full" controls />
                                                </div>
                                            ) : (
                                                <video src={gen.output_url!} className="w-full h-auto block" controls muted loop playsInline
                                                    onMouseEnter={(e) => e.currentTarget.play()}
                                                    onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />
                                            )}
                                            <div className={`absolute top-3 left-3 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider backdrop-blur-md ${badgeClass}`}>
                                                {badgeLabel}
                                            </div>
                                            <a href={gen.output_url!} download={`creation_${gen.id}.${inferDownloadExtension(gen)}`} target="_blank" rel="noopener noreferrer"
                                                className="absolute top-3 right-3 p-2 bg-black/60 hover:bg-purple-500/80 text-white rounded-full backdrop-blur-md transition-all opacity-0 group-hover:opacity-100 shadow-lg">
                                                <Download className="w-4 h-4" />
                                            </a>
                                        </div>
                                        <div className="p-4 flex items-center justify-between">
                                            <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                            <div className="flex items-center gap-3">
                                                {gen.duration && <span className="flex items-center gap-1 text-xs text-zinc-500"><Clock className="w-3 h-3" />{Math.round(gen.duration)}s</span>}
                                                {gen.cost && <span className="flex items-center gap-1 text-xs text-zinc-500"><Zap className="w-3 h-3" />{gen.cost}</span>}
                                            </div>
                                        </div>
                                        
                                        {/* Action Bar */}
                                        {!isAudio && (
                                            <div className="p-4 pt-0 flex gap-2">
                                                {gen.is_public ? (
                                                    <button 
                                                        onClick={() => handleUnpublish(gen.id)}
                                                        className="w-full flex items-center justify-center gap-2 py-2 bg-green-500/10 text-green-400 hover:bg-red-500/10 hover:text-red-400 border border-green-500/20 hover:border-red-500/20 rounded-xl text-sm font-medium transition-all group/pub"
                                                    >
                                                        <CheckCircle2 className="w-4 h-4 group-hover/pub:hidden" />
                                                        <X className="w-4 h-4 hidden group-hover/pub:block" />
                                                        <span className="group-hover/pub:hidden">Published</span>
                                                        <span className="hidden group-hover/pub:inline">Unpublish</span>
                                                    </button>
                                                ) : (
                                                    <button 
                                                        onClick={() => {
                                                            setSelectedGen(gen);
                                                            setPublishTitle('');
                                                            setPublishDesc('');
                                                            setPublishModalOpen(true);
                                                        }}
                                                        className="w-full flex items-center justify-center gap-2 py-2 bg-zinc-800/50 hover:bg-purple-600 border border-white/5 hover:border-purple-500 rounded-xl text-sm text-zinc-300 hover:text-white font-medium transition-all"
                                                    >
                                                        <Globe className="w-4 h-4" />
                                                        Publish to Showcase
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </motion.div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Failed */}
                {failedGenerations.length > 0 && (
                    <div className="mb-10">
                        <h2 className="text-xs font-bold text-red-400/80 uppercase tracking-widest mb-4">Failed ({failedGenerations.length})</h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            {failedGenerations.map((gen, i) => (
                                <motion.div key={gen.id} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                                    className="bg-zinc-900/30 rounded-2xl border border-red-500/20 overflow-hidden backdrop-blur-sm opacity-60">
                                    <div className={`${getMediaKind(gen) === 'audio' ? 'p-6' : 'aspect-video'} bg-black/60 flex items-center justify-center`}>
                                        <span className="text-xs text-red-400/60">Generation failed</span>
                                    </div>
                                    <div className="p-4 flex items-center justify-between">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        {gen.cost && <span className="flex items-center gap-1 text-xs text-zinc-500"><Zap className="w-3 h-3" />{gen.cost}</span>}
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Publish Modal */}
            <AnimatePresence>
                {publishModalOpen && selectedGen && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={() => setPublishModalOpen(false)}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
                    >
                        <motion.div
                            initial={{ scale: 0.95, y: 20 }}
                            animate={{ scale: 1, y: 0 }}
                            exit={{ scale: 0.95, y: 20 }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 w-full max-w-md shadow-2xl"
                        >
                            <div className="flex justify-between items-center mb-6">
                                <h3 className="text-xl font-bold flex items-center gap-2">
                                    <Globe className="w-5 h-5 text-purple-400" />
                                    Publish to Showcase
                                </h3>
                                <button onClick={() => setPublishModalOpen(false)} className="text-zinc-500 hover:text-white transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            
                            <p className="text-sm text-zinc-400 mb-6">
                                Share your creation with the community! This will make it visible on the public feed and allow others to remix it.
                            </p>

                            <form onSubmit={handlePublishSubmit} className="space-y-4">
                                <div>
                                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Title (Optional)</label>
                                    <input
                                        type="text"
                                        value={publishTitle}
                                        onChange={(e) => setPublishTitle(e.target.value)}
                                        placeholder="Give your creation a name"
                                        className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-purple-500 transition-colors"
                                        maxLength={60}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Description (Optional)</label>
                                    <textarea
                                        value={publishDesc}
                                        onChange={(e) => setPublishDesc(e.target.value)}
                                        placeholder="Share the story behind this, or some tips."
                                        rows={3}
                                        className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-purple-500 transition-colors resize-none"
                                        maxLength={200}
                                    />
                                </div>

                                <div className="pt-4 flex gap-3">
                                    <button
                                        type="button"
                                        onClick={() => setPublishModalOpen(false)}
                                        className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-medium transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={isPublishing}
                                        className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white rounded-xl font-medium transition-all shadow-[0_0_20px_-5px_rgba(168,85,247,0.4)] disabled:opacity-50 flex justify-center items-center"
                                    >
                                        {isPublishing ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Publish Now'}
                                    </button>
                                </div>
                            </form>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
