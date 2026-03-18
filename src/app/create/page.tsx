'use client';

import { ArrowRight, Video, Image as ImageIcon, Wand2, Clapperboard } from 'lucide-react';
import Link from 'next/link';

export default function CreateHubPage() {
    return (
        <div className="min-h-screen bg-black text-white p-6 pb-20 sm:p-12 font-[family-name:var(--font-geist-sans)] relative overflow-hidden flex flex-col items-center justify-center">
            {/* Background Effects */}
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[10%] left-[20%] w-[40%] h-[40%] bg-purple-900/10 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[20%] right-[10%] w-[30%] h-[30%] bg-pink-900/10 blur-[100px] rounded-full mix-blend-screen" />
                <div className="absolute inset-0 bg-[url('/noise.png')] opacity-[0.15] mix-blend-overlay" />
            </div>

            <div className="max-w-4xl w-full relative z-10">
                <div className="text-center mb-16">
                    <h1 className="text-4xl sm:text-5xl font-bold mb-4 tracking-tight">
                        What would you like to create?
                    </h1>
                    <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
                        Choose an AI tool below to start generating high-quality content in seconds.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">

                    {/* Image Generation */}
                    <Link href="/create-image" className="group relative bg-zinc-900/40 border border-white/10 p-8 rounded-3xl hover:bg-zinc-800/50 hover:border-purple-500/50 transition-all duration-300 flex flex-col overflow-hidden backdrop-blur-sm">
                        <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="w-14 h-14 bg-purple-500/10 border border-purple-500/20 text-purple-400 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                            <ImageIcon className="w-7 h-7" />
                        </div>
                        <h2 className="text-2xl font-bold mb-3 text-zinc-100 group-hover:text-white transition-colors">Generate Image</h2>
                        <p className="text-zinc-400 mb-8 flex-1 leading-relaxed">
                            Turn your text prompts into stunning, high-resolution images using state-of-the-art AI models.
                        </p>
                        <div className="flex items-center text-purple-400 font-medium group-hover:text-purple-300">
                            Start creating <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </div>
                    </Link>

                    {/* Motion Control (Current Create Page) */}
                    <Link href="/create-motion" className="group relative bg-zinc-900/40 border border-white/10 p-8 rounded-3xl hover:bg-zinc-800/50 hover:border-pink-500/50 transition-all duration-300 flex flex-col overflow-hidden backdrop-blur-sm">
                        <div className="absolute inset-0 bg-gradient-to-br from-pink-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="w-14 h-14 bg-pink-500/10 border border-pink-500/20 text-pink-400 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                            <Wand2 className="w-7 h-7" />
                        </div>
                        <h2 className="text-2xl font-bold mb-3 text-zinc-100 group-hover:text-white transition-colors">Motion Control</h2>
                        <p className="text-zinc-400 mb-8 flex-1 leading-relaxed">
                            Animate static photos using reference videos to create viral, ultra-realistic UGC video ads.
                        </p>
                        <div className="flex items-center text-pink-400 font-medium group-hover:text-pink-300">
                            Start animating <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </div>
                    </Link>

                    {/* Video Generation */}
                    <Link href="/create-video" className="group relative bg-zinc-900/40 border border-white/10 p-8 rounded-3xl hover:bg-zinc-800/50 hover:border-blue-500/50 transition-all duration-300 flex flex-col overflow-hidden backdrop-blur-sm">
                        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="w-14 h-14 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                            <Video className="w-7 h-7" />
                        </div>
                        <h2 className="text-2xl font-bold mb-3 text-zinc-100 group-hover:text-white transition-colors">Generate Video</h2>
                        <p className="text-zinc-400 mb-8 flex-1 leading-relaxed">
                            Create fully original videos from text prompts and reference images using Kling 3.0.
                        </p>
                        <div className="flex items-center text-blue-400 font-medium group-hover:text-blue-300">
                            Start generating <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </div>
                    </Link>


                    <Link href="/create-workflow" className="group relative bg-zinc-900/40 border border-white/10 p-8 rounded-3xl hover:bg-zinc-800/50 hover:border-emerald-500/50 transition-all duration-300 flex flex-col overflow-hidden backdrop-blur-sm">
                        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="w-14 h-14 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                            <Clapperboard className="w-7 h-7" />
                        </div>
                        <h2 className="text-2xl font-bold mb-3 text-zinc-100 group-hover:text-white transition-colors">AI Workflow</h2>
                        <p className="text-zinc-400 mb-8 flex-1 leading-relaxed">
                            Build an end-to-end ad or video plan with hooks, shots, asset prompts, and launch links into every model workflow.
                        </p>
                        <div className="flex items-center text-emerald-400 font-medium group-hover:text-emerald-300">
                            Plan the campaign <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </div>
                    </Link>

                </div>
            </div>
        </div>
    );
}
