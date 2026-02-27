'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Upload, Sparkles, Loader2, Download, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import localforage from 'localforage';

export default function CreatePage() {
    const router = useRouter();
    const [isLoadingUser, setIsLoadingUser] = useState(true);
    const [characterImage, setCharacterImage] = useState<string | null>(null);
    const [characterImageFile, setCharacterImageFile] = useState<File | null>(null);
    const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
    const [referenceVideoFile, setReferenceVideoFile] = useState<File | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [videoError, setVideoError] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [duration, setDuration] = useState<number>(0);
    const [characterOrientation, setCharacterOrientation] = useState<'video' | 'image'>('video');
    const [mode, setMode] = useState<'720p' | '1080p'>('720p');
    const [prompt, setPrompt] = useState<string>('The cartoon character is dancing.');
    const [isDraggingImage, setIsDraggingImage] = useState(false);
    const [isDraggingVideo, setIsDraggingVideo] = useState(false);

    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB in bytes

    const processImageFile = async (file: File) => {
        if (!file.type.startsWith('image/')) return;
        setCharacterImageFile(file);
        const url = URL.createObjectURL(file);
        setCharacterImage(url);
        await localforage.setItem('characterImageFile', file);
    };

    const processVideoFile = async (file: File) => {
        if (!file.type.startsWith('video/')) return;
        if (file.size > MAX_FILE_SIZE) {
            setVideoError('File size exceeds 100MB. Please upload a smaller video.');
            return;
        }
        setVideoError(null);
        setReferenceVideoFile(file);
        const url = URL.createObjectURL(file);
        setReferenceVideo(url);
        await localforage.setItem('referenceVideoFile', file);
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            await processImageFile(file);
            e.target.value = '';
        }
    };

    const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            await processVideoFile(file);
            e.target.value = '';
        }
    };

    const handleDragOver = (e: React.DragEvent, setDragging: (v: boolean) => void) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent, setDragging: (v: boolean) => void) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
    };

    const handleImageDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingImage(false);
        const file = e.dataTransfer.files?.[0];
        if (file) await processImageFile(file);
    };

    const handleVideoDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingVideo(false);
        const file = e.dataTransfer.files?.[0];
        if (file) await processVideoFile(file);
    };

    const handleClearImage = async (e: React.MouseEvent) => {
        e.preventDefault();
        setCharacterImageFile(null);
        setCharacterImage(null);
        await localforage.removeItem('characterImageFile');
    };

    const handleClearVideo = async (e: React.MouseEvent) => {
        e.preventDefault();
        setReferenceVideoFile(null);
        setReferenceVideo(null);
        setDuration(0);
        setVideoError(null);
        await localforage.removeItem('referenceVideoFile');
    };

    const MAX_VIDEO_DURATION = 30; // seconds

    const handleVideoMetadata = async (e: React.SyntheticEvent<HTMLVideoElement>) => {
        const videoDuration = e.currentTarget.duration;
        if (videoDuration > MAX_VIDEO_DURATION) {
            setVideoError(`Video length should be under ${MAX_VIDEO_DURATION}s. Your video is ${Math.round(videoDuration)}s.`);
            setReferenceVideoFile(null);
            setReferenceVideo(null);
            setDuration(0);
            await localforage.removeItem('referenceVideoFile');
            return;
        }
        setVideoError(null);
        setDuration(videoDuration);
    };

    // Helper for Supabase Upload
    const uploadToSupabase = async (file: File, bucket: string): Promise<string> => {
        const fileExt = file.name.split('.').pop();
        const fileName = `${Math.random().toString(36).substring(2)}.${fileExt}`;
        const filePath = `${fileName}`;

        const { error: uploadError } = await supabase.storage
            .from(bucket)
            .upload(filePath, file);

        if (uploadError) {
            throw new Error(`Upload failed: ${uploadError.message}`);
        }

        const { data } = supabase.storage
            .from(bucket)
            .getPublicUrl(filePath);

        return data.publicUrl;
    };

    // Verify authentication
    useEffect(() => {
        const checkUser = async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) {
                    router.push('/login?returnUrl=/create');
                    return;
                }
                setIsLoadingUser(false);
            } catch (err) {
                console.error('Auth check error:', err);
                router.push('/login?returnUrl=/create');
            }
        };

        checkUser();
    }, [router]);

    // --- NEW: Generation Recovery & Persistence ---
    useEffect(() => {
        // 1. Recover Inputs from IndexedDB
        const loadSavedFiles = async () => {
            try {
                const savedImageFile = await localforage.getItem<File>('characterImageFile');
                if (savedImageFile) {
                    setCharacterImageFile(savedImageFile);
                    setCharacterImage(URL.createObjectURL(savedImageFile));
                }

                const savedVideoFile = await localforage.getItem<File>('referenceVideoFile');
                if (savedVideoFile) {
                    setReferenceVideoFile(savedVideoFile);
                    setReferenceVideo(URL.createObjectURL(savedVideoFile));
                }
            } catch (err) {
                console.error("Error loading files from localforage:", err);
            }
        };
        loadSavedFiles();

        // 2. Check for Pending Generations
        const checkPendingGenerations = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            const { data } = await supabase
                .from('generations')
                .select('*')
                .eq('user_id', session.user.id)
                .in('status', ['processing', 'waiting'])
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (data) {
                console.log('Found pending generation:', data);
                setIsGenerating(true);
                setGenerationStatus('Resuming generation...');
                // Calculate elapsed time for progress bar simulation
                const startTime = new Date(data.created_at).getTime();
                const now = Date.now();
                const elapsedSeconds = (now - startTime) / 1000;
                setDuration(data.duration); // Restore duration for cost display

                // Resume polling
                pollPrediction(data.prediction_id, session.access_token, elapsedSeconds);
            }
        };

        checkPendingGenerations();
    }, []);



    const pollPrediction = async (predictionId: string, accessToken: string, initialElapsedSeconds = 0): Promise<string> => {
        const maxAttempts = 120; // 10 minutes max
        let attempts = 0;
        const startTime = Date.now() - (initialElapsedSeconds * 1000);

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate?id=${predictionId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            const data = await response.json();

            if (data.status === 'succeeded') {
                return data.output;
            } else if (data.status === 'failed') {
                throw new Error(data.error || 'Generation failed');
            }

            // Update Progress Bar
            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const expectedDuration = 300; // 5 minutes expected
            const progress = Math.min((elapsed / expectedDuration) * 95, 95); // Cap at 95% until done

            let statusMessage = "Processing...";
            if (progress < 10) statusMessage = "Uploading & Queuing...";
            else if (progress < 30) statusMessage = "Analyzing Motion...";
            else if (progress < 80) statusMessage = "Generating Frames...";
            else statusMessage = "Finalizing Video...";

            setGenerationStatus(`${statusMessage} (${Math.round(progress)}%)`);

            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error('Generation timed out');
    };
    // ----------------------------------------------

    const handleGenerate = async () => {
        if (!characterImageFile && !characterImage) { // check existing image too (from localStorage)
            alert('Please upload a character image');
            return;
        }
        if (!referenceVideoFile && !referenceVideo) {
            alert('Please upload a reference video');
            return;
        }

        const effectiveDuration = Math.ceil(duration);
        if (effectiveDuration <= 0) {
            alert('Invalid video duration');
            return;
        }

        setIsGenerating(true);
        setError(null);
        setOutputVideo(null);

        try {
            setGenerationStatus('Uploading files... (0%)');

            let imageUrl = characterImage;
            let videoUrl = referenceVideo;

            // Only upload if we have new files. If recovering from localStorage, they are base64/blob URLs which won't work for API directly
            // BUT: localStorage usually stores base64. The API needs a public URL. 
            // ISSUE: We can't easily "recover" the public URL unless we stored THAT in localStorage.
            // FIX: Let's assume for now user re-uploads if they refresh BEFORE clicking generate.
            // If they click generate, we get public URLs. We should persist THOSE if we want to be robust.
            // For now, let's just handle the "New Generation" flow correctly.

            if (characterImageFile) {
                imageUrl = await uploadToSupabase(characterImageFile, 'images');
            }
            if (referenceVideoFile) {
                videoUrl = await uploadToSupabase(referenceVideoFile, 'videos');
            }

            // If we still have base64 data URLs here, the API will fail.
            // Robust fix: We need to ensure we have remote URLs.
            // For this iteration, let's assume standard flow.

            setGenerationStatus('Starting AI generation... (5%)');

            // Get the session token
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                alert('Please log in to generate videos');
                setIsGenerating(false);
                return;
            }

            // Call our API to start the generation
            const response = await fetch('/api/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    characterImageUrl: imageUrl,
                    referenceVideoUrl: videoUrl,
                    duration: effectiveDuration,
                    characterOrientation,
                    mode,
                    prompt
                })
            });

            const data = await response.json();

            if (!data.success) {
                const errorMessage = data.details
                    ? `${data.error}: ${data.details} (Code: ${data.code})`
                    : (data.error || 'Failed to start generation');
                throw new Error(errorMessage);
            }

            // Poll for completion
            const outputUrl = await pollPrediction(data.predictionId, session.access_token);
            setOutputVideo(outputUrl);
            setGenerationStatus('Video generated successfully! (100%)');

        } catch (err) {
            console.error('Generation error:', err);
            setError(err instanceof Error ? err.message : 'Something went wrong');
            setGenerationStatus(null);
        } finally {
            setIsGenerating(false);
        }
    };

    if (isLoadingUser) {
        return (
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }

    // Helper to extract percentage for Progress Bar
    const getProgressPercentage = () => {
        if (!generationStatus) return 0;
        const match = generationStatus.match(/\((\d+)%\)/);
        return match ? parseInt(match[1]) : 0;
    };

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <div className="max-w-5xl mx-auto">
                {/* Header */}
                <div className="flex items-center gap-4 mb-12">
                    <Link
                        href="/"
                        className="group p-3 rounded-full bg-zinc-900/50 border border-white/5 hover:bg-zinc-800 hover:border-white/10 transition-all backdrop-blur-md"
                    >
                        <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">Creation Workspace</h1>
                        <p className="text-sm text-zinc-500 font-medium tracking-wide">AI MOTION TRANSFER GENERATOR</p>
                    </div>
                </div>
            </div>

            <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
                {/* Character Image Upload */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col gap-4 bg-zinc-900/30 p-6 rounded-3xl border border-white/5 backdrop-blur-sm"
                >
                    <div className="flex flex-col gap-1">
                        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2 mt-1">
                            <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-[10px] border border-purple-500/30">1</span>
                            Upload Character
                        </h2>
                        <p className="text-sm text-zinc-500 mb-2">High-res, full body photo works best.</p>
                    </div>

                    <label
                        className={`group flex flex-col items-center justify-center w-full h-[320px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDraggingImage
                                ? 'border-purple-400 bg-purple-500/10 shadow-[0_0_30px_-5px_rgba(168,85,247,0.3)]'
                                : 'border-zinc-700/50 hover:border-purple-500/50 hover:bg-purple-500/5'
                            }`}
                        onDragOver={(e) => handleDragOver(e, setIsDraggingImage)}
                        onDragLeave={(e) => handleDragLeave(e, setIsDraggingImage)}
                        onDrop={handleImageDrop}
                    >
                        {characterImage ? (
                            <div className="w-full h-full flex items-center justify-center bg-black/50">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={characterImage}
                                    alt="Character"
                                    className="w-full h-full object-contain"
                                />
                                <button
                                    onClick={handleClearImage}
                                    className="absolute top-4 right-4 p-2 bg-black/60 hover:bg-red-500/80 text-white rounded-full backdrop-blur-md transition-all shadow-lg hover:rotate-90"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-3 text-zinc-500">
                                <Upload className={`w-8 h-8 transition-colors ${isDraggingImage ? 'text-purple-400' : ''}`} />
                                <span className="text-sm">{isDraggingImage ? 'Drop image here' : 'Click or drag & drop image'}</span>
                            </div>
                        )}
                        <input
                            type="file"
                            accept="image/*"
                            onChange={handleImageUpload}
                            className="hidden"
                        />
                    </label>
                    <p className="text-xs text-zinc-600 mt-1">Supported formats: JPG, PNG, WEBP &nbsp;|&nbsp; Max size: 100MB</p>
                </motion.div>

                {/* Reference Video Upload */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="flex flex-col gap-4 bg-zinc-900/30 p-6 rounded-3xl border border-white/5 backdrop-blur-sm"
                >
                    <div className="flex flex-col gap-1">
                        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2 mt-1">
                            <span className="w-5 h-5 rounded-full bg-pink-500/20 text-pink-400 flex items-center justify-center text-[10px] border border-pink-500/30">2</span>
                            Reference Video
                        </h2>
                        <p className="text-sm text-zinc-500 mb-2">The desired motion or action.</p>
                    </div>

                    <label
                        className={`group flex flex-col items-center justify-center w-full h-[320px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDraggingVideo
                                ? 'border-pink-400 bg-pink-500/10 shadow-[0_0_30px_-5px_rgba(236,72,153,0.3)]'
                                : 'border-zinc-700/50 hover:border-pink-500/50 hover:bg-pink-500/5'
                            }`}
                        onDragOver={(e) => handleDragOver(e, setIsDraggingVideo)}
                        onDragLeave={(e) => handleDragLeave(e, setIsDraggingVideo)}
                        onDrop={handleVideoDrop}
                    >
                        {referenceVideo ? (
                            <div className="w-full h-full flex items-center justify-center bg-black/50 relative">
                                <video
                                    src={referenceVideo}
                                    className="w-full h-full object-contain"
                                    controls
                                    autoPlay
                                    loop
                                    muted
                                    onLoadedMetadata={handleVideoMetadata}
                                />
                                <button
                                    onClick={handleClearVideo}
                                    className="absolute top-4 right-4 p-2 bg-black/60 hover:bg-red-500/80 text-white rounded-full backdrop-blur-md transition-all shadow-lg hover:rotate-90 z-10"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-3 text-zinc-500">
                                <Upload className={`w-8 h-8 transition-colors ${isDraggingVideo ? 'text-pink-400' : ''}`} />
                                <span className="text-sm">{isDraggingVideo ? 'Drop video here' : 'Click or drag & drop video'}</span>
                            </div>
                        )}
                        <input
                            type="file"
                            accept="video/*"
                            onChange={handleVideoUpload}
                            className="hidden"
                        />
                    </label>
                    <p className="text-xs text-zinc-600 mt-1">Supported formats: MP4, MOV, WEBM &nbsp;|&nbsp; Max size: 100MB &nbsp;|&nbsp; Max duration: 30s</p>
                    {videoError && (
                        <div className="mt-2 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl">
                            <p className="text-sm text-red-400">{videoError}</p>
                        </div>
                    )}
                </motion.div>
            </div>

            {/* Settings: Orientation and Mode */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
                className="mt-8 grid md:grid-cols-2 gap-8 max-w-5xl mx-auto"
            >
                <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-8 backdrop-blur-sm">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Character Orientation</h3>
                    <div className="flex gap-4">
                        <button
                            onClick={() => setCharacterOrientation('video')}
                            className={`flex-[1] py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-300 ${characterOrientation === 'video'
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-[0_0_15px_-3px_rgba(168,85,247,0.3)]'
                                : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                }`}
                        >
                            Follow Video
                        </button>
                        <button
                            onClick={() => setCharacterOrientation('image')}
                            className={`flex-[1] py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-300 ${characterOrientation === 'image'
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-[0_0_15px_-3px_rgba(168,85,247,0.3)]'
                                : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                }`}
                        >
                            Follow Image
                        </button>
                    </div>
                </div>

                <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-8 backdrop-blur-sm">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Quality Mode</h3>
                    <div className="flex gap-4">
                        <button
                            onClick={() => setMode('720p')}
                            className={`flex-[1] py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-300 ${mode === '720p'
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-[0_0_15px_-3px_rgba(168,85,247,0.3)]'
                                : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                }`}
                        >
                            Standard (720p)
                        </button>
                        <button
                            onClick={() => setMode('1080p')}
                            className={`flex-[1] relative py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-300 overflow-hidden group ${mode === '1080p'
                                ? 'bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-pink-300 border border-pink-500/50 shadow-[0_0_15px_-3px_rgba(236,72,153,0.3)]'
                                : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                }`}
                        >
                            <span className="relative z-10">Pro (1080p)</span>
                            {mode !== '1080p' && (
                                <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-pink-500/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                            )}
                        </button>
                    </div>
                </div>

                <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-8 md:col-span-2 backdrop-blur-sm">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Prompt Configuration</h3>
                    <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="e.g., The cartoon character is dancing happily..."
                        className="w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 focus:border-purple-500/50 focus:ring-4 focus:ring-purple-500/10 outline-none resize-y min-h-[120px] placeholder:text-zinc-600 transition-all text-sm leading-relaxed"
                    />
                </div>
            </motion.div>

            {/* Duration and Cost Display */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="mt-8 flex flex-col gap-4 items-center"
            >
                {duration > 0 ? (
                    <div className="bg-purple-900/10 border border-purple-500/20 rounded-2xl p-6 text-center w-full max-w-md shadow-[0_0_30px_-10px_rgba(168,85,247,0.15)] flex flex-col items-center justify-center">
                        <div className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400 mb-1">
                            {Math.ceil(duration * (mode === '1080p' ? 9 : 6))} Credits
                        </div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Estimated Cost</p>
                        <div className="h-[1px] w-12 bg-zinc-800 mb-2" />
                        <p className="text-sm text-zinc-400">
                            Based on {duration.toFixed(1)}s video length at {mode === '1080p' ? '9' : '6'} credits/sec
                        </p>
                    </div>
                ) : (
                    <div className="bg-zinc-900/20 border border-white/5 rounded-2xl p-6 text-center w-full max-w-md backdrop-blur-sm">
                        <p className="text-zinc-500 text-sm">Upload a video to see cost estimation.</p>
                    </div>
                )}
            </motion.div>

            {/* Generate Button and Progress Bar */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="mt-8 flex flex-col items-center gap-4 w-full max-w-2xl mx-auto"
            >
                <button
                    onClick={handleGenerate}
                    disabled={(!characterImage && !characterImageFile) || (!referenceVideo && !referenceVideoFile) || isGenerating}
                    className="flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-600 rounded-full font-medium text-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed w-full justify-center"
                >
                    {isGenerating ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            Generating...
                        </>
                    ) : (
                        <>
                            <Sparkles className="w-5 h-5" />
                            Generate Video ({duration > 0 ? `${Math.ceil(duration)}s` : ''})
                        </>
                    )}
                </button>
                {duration > 0 && !isGenerating && (
                    <p className="text-xs text-zinc-500">
                        Cost: {Math.ceil(duration * (mode === '1080p' ? 9 : 6))} Credits
                    </p>
                )}

                {/* Progress Bar System */}
                {isGenerating && generationStatus && (
                    <div className="w-full mt-4 space-y-2">
                        <div className="flex justify-between text-sm text-zinc-400 px-1">
                            <span>{generationStatus}</span>
                            <span>{getProgressPercentage()}%</span>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                            <motion.div
                                className="h-full bg-gradient-to-r from-purple-500 to-pink-500"
                                initial={{ width: "0%" }}
                                animate={{ width: `${getProgressPercentage()}%` }}
                                transition={{ duration: 0.5 }}
                            />
                        </div>
                        <p className="text-xs text-zinc-600 text-center pt-2">
                            Estimated time: ~3-5 minutes. You can safely close or refresh this page.
                        </p>
                    </div>
                )}

                {error && (
                    <div className="flex flex-col items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl mt-4">
                        <p className="text-sm text-red-400 text-center">{error}</p>
                        {error.toLowerCase().includes('insufficient') && (
                            <Link href="/pricing" className="mt-2 px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-full transition-colors flex items-center gap-2 hover:opacity-90 font-medium text-sm">
                                <Sparkles className="w-4 h-4 text-yellow-400" />
                                Top Up Credits
                            </Link>
                        )}
                    </div>
                )}
            </motion.div>

            {/* Output Video */}
            {outputVideo && (
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="mt-12 flex flex-col items-center gap-6"
                >
                    <h2 className="text-xl font-bold text-green-400">🎉 Your Video is Ready!</h2>

                    <div className="w-full max-w-lg rounded-2xl overflow-hidden border border-zinc-800">
                        <video
                            src={outputVideo}
                            controls
                            autoPlay
                            loop
                            className="w-full"
                        />
                    </div>

                    <a
                        href={outputVideo}
                        download="generated-video.mp4"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 rounded-full font-medium transition-colors"
                    >
                        <Download className="w-5 h-5" />
                        Download Video
                    </a>
                </motion.div>
            )}
        </div>
    );
}
