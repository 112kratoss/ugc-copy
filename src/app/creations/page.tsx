'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Clock, Zap, Film, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabase';

interface Generation {
    id: string;
    output_url: string | null;
    status: string;
    created_at: string;
    duration: number;
    cost: number;
    model: string;
}

export default function CreationsPage() {
    const router = useRouter();
    const [generations, setGenerations] = useState<Generation[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchCreations = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                router.push('/login');
                return;
            }

            try {
                const res = await fetch('/api/generations', {
                    headers: {
                        'Authorization': `Bearer ${session.access_token}`,
                    },
                });
                const data = await res.json();
                if (res.ok) {
                    setGenerations(data.generations || []);
                }
            } catch (err) {
                console.error('Failed to fetch creations:', err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchCreations();
    }, [router]);

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const successfulGenerations = generations.filter(g => g.status === 'succeeded' && g.output_url);
    const processingGenerations = generations.filter(g => g.status === 'processing');
    const failedGenerations = generations.filter(g => g.status === 'failed');

    return (
        <div className="min-h-screen bg-black text-white">
            {/* Background effects */}
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-purple-900/15 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-pink-900/10 blur-[120px] rounded-full mix-blend-screen" />
            </div>

            <div className="relative z-10 max-w-7xl mx-auto px-6 py-8">
                {/* Header */}
                <div className="flex items-center gap-4 mb-10">
                    <Link
                        href="/"
                        className="group p-3 rounded-full bg-zinc-900/50 border border-white/5 hover:bg-zinc-800 hover:border-white/10 transition-all backdrop-blur-md"
                    >
                        <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">
                            My Creations
                        </h1>
                        <p className="text-sm text-zinc-500 font-medium tracking-wide">
                            {successfulGenerations.length} VIDEO{successfulGenerations.length !== 1 ? 'S' : ''} GENERATED
                        </p>
                    </div>
                </div>

                {/* Loading State */}
                {isLoading && (
                    <div className="flex flex-col items-center justify-center py-32 gap-4">
                        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                        <p className="text-zinc-500 text-sm">Loading your creations...</p>
                    </div>
                )}

                {/* Empty State */}
                {!isLoading && generations.length === 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="flex flex-col items-center justify-center py-32 gap-6"
                    >
                        <div className="p-6 rounded-full bg-zinc-900/50 border border-white/5">
                            <Film className="w-12 h-12 text-zinc-600" />
                        </div>
                        <div className="text-center">
                            <h2 className="text-xl font-semibold text-zinc-300 mb-2">No creations yet</h2>
                            <p className="text-zinc-500 text-sm max-w-md">
                                You haven&apos;t generated any videos yet. Head over to the workspace to create your first masterpiece!
                            </p>
                        </div>
                        <Link
                            href="/create"
                            className="group relative overflow-hidden rounded-full p-[1px] bg-gradient-to-r from-purple-500 to-pink-500 hover:shadow-[0_0_30px_-5px_rgba(168,85,247,0.5)] transition-all duration-300 hover:scale-105"
                        >
                            <div className="flex items-center justify-center gap-2 bg-zinc-950 px-8 py-3 rounded-full transition-all duration-300 group-hover:bg-opacity-0">
                                <span className="font-semibold text-white">Start Creating</span>
                            </div>
                        </Link>
                    </motion.div>
                )}

                {/* Processing Videos */}
                {processingGenerations.length > 0 && (
                    <div className="mb-10">
                        <h2 className="text-xs font-bold text-yellow-400/80 uppercase tracking-widest mb-4 flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Processing ({processingGenerations.length})
                        </h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            {processingGenerations.map((gen, i) => (
                                <motion.div
                                    key={gen.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: i * 0.05 }}
                                    className="bg-zinc-900/30 rounded-2xl border border-yellow-500/20 overflow-hidden backdrop-blur-sm"
                                >
                                    <div className="aspect-video bg-black/60 flex items-center justify-center">
                                        <div className="flex flex-col items-center gap-3">
                                            <Loader2 className="w-8 h-8 text-yellow-400 animate-spin" />
                                            <span className="text-xs text-zinc-500">Generating...</span>
                                        </div>
                                    </div>
                                    <div className="p-4">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Successful Videos */}
                {successfulGenerations.length > 0 && (
                    <div className="mb-10">
                        {processingGenerations.length > 0 && (
                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">
                                Completed
                            </h2>
                        )}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            {successfulGenerations.map((gen, i) => (
                                <motion.div
                                    key={gen.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: i * 0.05 }}
                                    className="group bg-zinc-900/30 rounded-2xl border border-white/5 overflow-hidden backdrop-blur-sm hover:border-purple-500/30 hover:shadow-[0_0_30px_-10px_rgba(168,85,247,0.2)] transition-all duration-300"
                                >
                                    {/* Video Player */}
                                    <div className="aspect-video bg-black/60 relative overflow-hidden">
                                        <video
                                            src={gen.output_url!}
                                            className="w-full h-full object-cover"
                                            controls
                                            muted
                                            loop
                                            playsInline
                                            onMouseEnter={(e) => e.currentTarget.play()}
                                            onMouseLeave={(e) => {
                                                e.currentTarget.pause();
                                                e.currentTarget.currentTime = 0;
                                            }}
                                        />
                                        {/* Download button overlay */}
                                        <a
                                            href={gen.output_url!}
                                            download={`creation_${gen.id}.mp4`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="absolute top-3 right-3 p-2 bg-black/60 hover:bg-purple-500/80 text-white rounded-full backdrop-blur-md transition-all opacity-0 group-hover:opacity-100 shadow-lg"
                                        >
                                            <Download className="w-4 h-4" />
                                        </a>
                                    </div>

                                    {/* Meta Info */}
                                    <div className="p-4 flex items-center justify-between">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        <div className="flex items-center gap-3">
                                            {gen.duration && (
                                                <span className="flex items-center gap-1 text-xs text-zinc-500">
                                                    <Clock className="w-3 h-3" />
                                                    {Math.round(gen.duration)}s
                                                </span>
                                            )}
                                            {gen.cost && (
                                                <span className="flex items-center gap-1 text-xs text-zinc-500">
                                                    <Zap className="w-3 h-3" />
                                                    {gen.cost}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Failed Videos */}
                {failedGenerations.length > 0 && (
                    <div className="mb-10">
                        <h2 className="text-xs font-bold text-red-400/80 uppercase tracking-widest mb-4">
                            Failed ({failedGenerations.length})
                        </h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                            {failedGenerations.map((gen, i) => (
                                <motion.div
                                    key={gen.id}
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: i * 0.05 }}
                                    className="bg-zinc-900/30 rounded-2xl border border-red-500/20 overflow-hidden backdrop-blur-sm opacity-60"
                                >
                                    <div className="aspect-video bg-black/60 flex items-center justify-center">
                                        <span className="text-xs text-red-400/60">Generation failed</span>
                                    </div>
                                    <div className="p-4 flex items-center justify-between">
                                        <p className="text-xs text-zinc-500">{formatDate(gen.created_at)}</p>
                                        {gen.cost && (
                                            <span className="flex items-center gap-1 text-xs text-zinc-500">
                                                <Zap className="w-3 h-3" />
                                                {gen.cost}
                                            </span>
                                        )}
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
