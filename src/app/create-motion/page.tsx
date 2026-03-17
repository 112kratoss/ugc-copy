'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Upload, Sparkles, Loader2, Download, X, Zap, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import localforage from 'localforage';

// ─── Model Registry ───────────────────────────────────────────────────────────
const MOTION_MODELS = {
    'kling-2.6': {
        id: 'kling-2.6',
        displayName: 'Kling 2.6',
        description: 'Reliable motion transfer with smooth character animation',
        badge: 'Stable',
        badgeColor: 'from-purple-500 to-pink-500',
        maxVideoDuration: 30, // seconds
        characterOrientations: ['video', 'image'] as const,
        resolutions: ['720p', '1080p'] as const,
    },
    'kling-3.0': {
        id: 'kling-3.0',
        displayName: 'Kling 3.0',
        description: 'Latest model — enhanced fidelity and motion accuracy',
        badge: 'New',
        badgeColor: 'from-violet-500 to-indigo-500',
        maxVideoDuration: 30,
        characterOrientations: ['video', 'image'] as const,
        resolutions: ['720p', '1080p'] as const,
    },
} as const;

type ModelId = keyof typeof MOTION_MODELS;

export default function CreatePage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-zinc-500" /></div>}>
            <CreateMotionContent />
        </Suspense>
    );
}

function CreateMotionContent() {
    const router = useRouter();
    const [isLoadingUser, setIsLoadingUser] = useState(true);
    const [selectedModel, setSelectedModel] = useState<ModelId>('kling-3.0');
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

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
    const [prompt, setPrompt] = useState<string>("No distortion, the character's movements are consistent with the video.");
    const [isDraggingImage, setIsDraggingImage] = useState(false);
    const [isDraggingVideo, setIsDraggingVideo] = useState(false);
    const [userCredits, setUserCredits] = useState<number | null>(null);

    // Remix State
    const searchParams = useSearchParams();
    const remixId = searchParams.get('remix');
    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);

    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
    const model = MOTION_MODELS[selectedModel];

    // Close dropdown on click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setIsModelDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

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
        if (file) { await processImageFile(file); e.target.value = ''; }
    };

    const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) { await processVideoFile(file); e.target.value = ''; }
    };

    const handleDragOver = (e: React.DragEvent, setDragging: (v: boolean) => void) => {
        e.preventDefault(); e.stopPropagation(); setDragging(true);
    };
    const handleDragLeave = (e: React.DragEvent, setDragging: (v: boolean) => void) => {
        e.preventDefault(); e.stopPropagation(); setDragging(false);
    };

    const handleImageDrop = async (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation(); setIsDraggingImage(false);
        const file = e.dataTransfer.files?.[0];
        if (file) await processImageFile(file);
    };

    const handleVideoDrop = async (e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation(); setIsDraggingVideo(false);
        const file = e.dataTransfer.files?.[0];
        if (file) await processVideoFile(file);
    };

    const handleClearImage = async (e: React.MouseEvent) => {
        e.preventDefault();
        setCharacterImageFile(null); setCharacterImage(null);
        await localforage.removeItem('characterImageFile');
    };

    const handleClearVideo = async (e: React.MouseEvent) => {
        e.preventDefault();
        setReferenceVideoFile(null); setReferenceVideo(null);
        setDuration(0); setVideoError(null);
        await localforage.removeItem('referenceVideoFile');
    };

    const handleVideoMetadata = async (e: React.SyntheticEvent<HTMLVideoElement>) => {
        const videoDuration = e.currentTarget.duration;
        if (videoDuration > model.maxVideoDuration) {
            setVideoError(`Video length should be under ${model.maxVideoDuration}s. Your video is ${Math.round(videoDuration)}s.`);
            setReferenceVideoFile(null); setReferenceVideo(null); setDuration(0);
            await localforage.removeItem('referenceVideoFile');
            return;
        }
        setVideoError(null);
        setDuration(videoDuration);
    };

    const uploadToSupabase = async (file: File, bucket: string): Promise<string> => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Please log in to upload files.');

        const fileExt = file.name.split('.').pop();
        const fileName = `${user.id}/${Math.random().toString(36).substring(2)}.${fileExt}`;
        const { error: uploadError } = await supabase.storage.from(bucket).upload(fileName, file);
        if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

        const { data: signedData, error: signedUrlError } = await supabase.storage
            .from(bucket)
            .createSignedUrl(fileName, 3600);

        if (signedUrlError || !signedData?.signedUrl) {
            throw new Error(`Signed URL generation failed: ${signedUrlError?.message || 'Unknown error'}`);
        }

        return signedData.signedUrl;
    };

    // Verify authentication & fetch credits
    useEffect(() => {
        const checkUser = async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) { router.push('/login?returnUrl=/create-motion'); return; }
                setIsLoadingUser(false);
                const { data: profile } = await supabase.from('profiles').select('credits').eq('id', user.id).single();
                if (profile) setUserCredits(profile.credits);
            } catch (err) {
                console.error('Auth check error:', err);
                router.push('/login?returnUrl=/create-motion');
            }
        };
        checkUser();
    }, [router]);

    // Handle Remix Pre-fill
    useEffect(() => {
        if (!remixId) return;

        const fetchRemixData = async () => {
             const { data: { session } } = await supabase.auth.getSession();
             if (!session) return;

             try {
                 const { data, error } = await supabase
                     .from('generations')
                     .select('title, prompt, workflow_settings')
                     .eq('id', remixId)
                     .single();

                 if (error || !data) {
                     console.error('Failed to load remix data');
                     return;
                 }

                 if (data.title) setRemixTitle(data.title);
                 if (data.prompt) setPrompt(data.prompt);
                 
                 const settings = data.workflow_settings as any;
                 if (settings) {
                     if (settings.model && MOTION_MODELS[settings.model as ModelId]) {
                         setSelectedModel(settings.model as ModelId);
                     }
                     if (settings.mode) setMode(settings.mode);
                     if (settings.characterOrientation) setCharacterOrientation(settings.characterOrientation);
                 }
             } catch (err) {
                 console.error('Error fetching remix:', err);
             } finally {
                 setIsRemixLoading(false);
             }
        };

        fetchRemixData();
    }, [remixId]);

    // Generation Recovery & Persistence
    useEffect(() => {
        const loadSavedFiles = async () => {
            try {
                const savedImageFile = await localforage.getItem<File>('characterImageFile');
                if (savedImageFile) { setCharacterImageFile(savedImageFile); setCharacterImage(URL.createObjectURL(savedImageFile)); }
                const savedVideoFile = await localforage.getItem<File>('referenceVideoFile');
                if (savedVideoFile) { setReferenceVideoFile(savedVideoFile); setReferenceVideo(URL.createObjectURL(savedVideoFile)); }
            } catch (err) { console.error("Error loading files from localforage:", err); }
        };
        loadSavedFiles();

        const checkPendingGenerations = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;
            const { data } = await supabase
                .from('generations').select('*')
                .eq('user_id', session.user.id)
                .in('status', ['processing', 'waiting'])
                .order('created_at', { ascending: false })
                .limit(1).single();
            if (data) {
                setIsGenerating(true);
                setGenerationStatus('Resuming generation...');
                const startTime = new Date(data.created_at).getTime();
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                setDuration(data.duration);
                pollPrediction(data.prediction_id, session.access_token, elapsedSeconds);
            }
        };
        checkPendingGenerations();
    }, []);

    const pollPrediction = async (predictionId: string, accessToken: string, initialElapsedSeconds = 0): Promise<string> => {
        const maxAttempts = 240;
        let attempts = 0;
        const startTime = Date.now() - (initialElapsedSeconds * 1000);

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate?id=${predictionId}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            const data = await response.json();

            if (data.status === 'succeeded') return data.output;
            else if (data.status === 'failed') throw new Error(data.error || 'Generation failed');

            const elapsed = (Date.now() - startTime) / 1000;
            const progress = Math.min((elapsed / 300) * 95, 95);

            let statusMessage = "Processing...";
            if (progress < 10) statusMessage = "Uploading & Queuing...";
            else if (progress < 30) statusMessage = "Analyzing Motion...";
            else if (progress < 80) statusMessage = "Generating Frames...";
            else statusMessage = "Finalizing Video...";

            setGenerationStatus(`${statusMessage} (${Math.round(progress)}%)`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error('__GENERATION_TIMEOUT__');
    };

    const handleGenerate = async () => {
        if (!characterImageFile && !characterImage) { alert('Please upload a character image'); return; }
        if (!referenceVideoFile && !referenceVideo) { alert('Please upload a reference video'); return; }
        const effectiveDuration = Math.ceil(duration);
        if (effectiveDuration <= 0) { alert('Invalid video duration'); return; }

        setIsGenerating(true); setError(null); setOutputVideo(null);

        try {
            setGenerationStatus('Uploading files... (0%)');
            let imageUrl = characterImage;
            let videoUrl = referenceVideo;

            if (characterImageFile) imageUrl = await uploadToSupabase(characterImageFile, 'uploads');
            if (referenceVideoFile) videoUrl = await uploadToSupabase(referenceVideoFile, 'uploads');

            setGenerationStatus('Starting AI generation... (5%)');
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) { router.push('/login?returnUrl=/create-motion'); setIsGenerating(false); return; }

            const response = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
                body: JSON.stringify({
                    model: selectedModel,
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

            const outputUrl = await pollPrediction(data.predictionId, session.access_token);
            setOutputVideo(outputUrl);
            setGenerationStatus('Video generated successfully! (100%)');

        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Something went wrong';
            if (msg === '__GENERATION_TIMEOUT__') {
                setGenerationStatus('⏳ Still processing... (100%)');
                setError('__TIMEOUT_INFO__');
            } else {
                setError(msg);
                setGenerationStatus(null);
            }
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

    const getProgressPercentage = () => {
        if (!generationStatus) return 0;
        const match = generationStatus.match(/\((\d+)%\)/);
        return match ? parseInt(match[1]) : 0;
    };

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <div className="max-w-5xl mx-auto">
                {/* Header */}
                <div className="flex items-center gap-4 mb-10">
                    <Link
                        href="/"
                        className="group p-3 rounded-full bg-zinc-900/50 border border-white/5 hover:bg-zinc-800 hover:border-white/10 transition-all backdrop-blur-md"
                    >
                        <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">Creation Workspace</h1>
                        <p className="text-sm text-zinc-500 font-medium tracking-wide">AI MOTION TRANSFER · {model.displayName.toUpperCase()}</p>
                    </div>
                    {userCredits !== null && (
                        <div className="ml-auto flex items-center gap-2 px-4 py-2 bg-zinc-900/50 border border-white/5 rounded-full backdrop-blur-md">
                            <Sparkles className="w-4 h-4 text-purple-400" />
                            <span className="text-sm font-semibold text-white">{userCredits}</span>
                            <span className="text-xs text-zinc-500">credits</span>
                        </div>
                    )}
                </div>

                {/* Remix Banner */}
                <AnimatePresence>
                    {remixId && !isRemixLoading && (
                        <motion.div
                            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                            animate={{ opacity: 1, height: 'auto', marginBottom: 32 }}
                            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                            className="bg-purple-900/20 border border-purple-500/30 rounded-2xl p-4 flex items-center gap-3 overflow-hidden backdrop-blur-md"
                        >
                            <div className="p-2 bg-purple-500/20 rounded-full">
                                <Sparkles className="w-5 h-5 text-purple-400" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-purple-100 text-sm">Remixing Community Creation</h3>
                                <p className="text-xs text-purple-300/80">
                                    Settings pre-filled from {remixTitle ? `"${remixTitle}"` : 'the original creation'}. Modify as needed!
                                </p>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* ─── Model Selector Dropdown ───────────────────────────────────── */}
                <div className="mb-8 relative" ref={dropdownRef}>
                    <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-3">Model</p>
                    <button
                        onClick={() => setIsModelDropdownOpen(prev => !prev)}
                        className="w-full flex items-center justify-between gap-3 px-5 py-4 bg-zinc-900/50 border border-white/10 rounded-2xl hover:bg-zinc-900/70 hover:border-white/15 transition-all backdrop-blur-sm"
                    >
                        <div className="flex items-center gap-3">
                            <Zap className="w-4 h-4 text-white" />
                            <div className="text-left">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-bold text-white">{model.displayName}</span>
                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r ${model.badgeColor} text-white`}>
                                        {model.badge}
                                    </span>
                                </div>
                                <p className="text-xs text-zinc-500 mt-0.5">{model.description}</p>
                            </div>
                        </div>
                        <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    <AnimatePresence>
                        {isModelDropdownOpen && (
                            <motion.div
                                initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                animate={{ opacity: 1, y: 0, scaleY: 1 }}
                                exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                transition={{ duration: 0.15 }}
                                className="absolute z-50 mt-2 w-full bg-zinc-900/95 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)]"
                                style={{ transformOrigin: 'top' }}
                            >
                                {(Object.values(MOTION_MODELS) as typeof MOTION_MODELS[ModelId][]).map((m) => {
                                    const isActive = selectedModel === m.id;
                                    return (
                                        <button
                                            key={m.id}
                                            onClick={() => { setSelectedModel(m.id as ModelId); setIsModelDropdownOpen(false); }}
                                            className={`w-full text-left px-5 py-4 flex items-center gap-3 transition-all ${isActive ? 'bg-white/5' : 'hover:bg-white/[0.03]'}`}
                                        >
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-sm font-bold ${isActive ? 'text-white' : 'text-zinc-300'}`}>{m.displayName}</span>
                                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r ${m.badgeColor} text-white`}>{m.badge}</span>
                                                </div>
                                                <p className="text-xs text-zinc-500 mt-0.5">{m.description}</p>
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-white/5">
                                                        Max {m.maxVideoDuration}s video
                                                    </span>
                                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-white/5">
                                                        720p / 1080p
                                                    </span>
                                                </div>
                                            </div>
                                            {isActive && <Check className="w-4 h-4 text-purple-400 shrink-0" />}
                                        </button>
                                    );
                                })}
                            </motion.div>
                        )}
                    </AnimatePresence>
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
                                <img src={characterImage} alt="Character" className="w-full h-full object-contain" />
                                <button onClick={handleClearImage} className="absolute top-4 right-4 p-2 bg-black/60 hover:bg-red-500/80 text-white rounded-full backdrop-blur-md transition-all shadow-lg hover:rotate-90">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-3 text-zinc-500">
                                <Upload className={`w-8 h-8 transition-colors ${isDraggingImage ? 'text-purple-400' : ''}`} />
                                <span className="text-sm">{isDraggingImage ? 'Drop image here' : 'Click or drag & drop image'}</span>
                            </div>
                        )}
                        <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                    </label>
                    <p className="text-xs text-zinc-600 mt-1">Supported formats: JPG, PNG, WEBP &nbsp;|&nbsp; Max size: 10MB &nbsp;|&nbsp; Min 300px</p>
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
                                    controls autoPlay loop muted
                                    onLoadedMetadata={handleVideoMetadata}
                                />
                                <button onClick={handleClearVideo} className="absolute top-4 right-4 p-2 bg-black/60 hover:bg-red-500/80 text-white rounded-full backdrop-blur-md transition-all shadow-lg hover:rotate-90 z-10">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-3 text-zinc-500">
                                <Upload className={`w-8 h-8 transition-colors ${isDraggingVideo ? 'text-pink-400' : ''}`} />
                                <span className="text-sm">{isDraggingVideo ? 'Drop video here' : 'Click or drag & drop video'}</span>
                            </div>
                        )}
                        <input type="file" accept="video/*" onChange={handleVideoUpload} className="hidden" />
                    </label>
                    <p className="text-xs text-zinc-600 mt-1">MP4/MOV &nbsp;|&nbsp; Max 100MB &nbsp;|&nbsp; Max {model.maxVideoDuration}s</p>
                    {videoError && (
                        <div className="mt-2 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl">
                            <p className="text-sm text-red-400">{videoError}</p>
                        </div>
                    )}
                </motion.div>
            </div>

            {/* Settings */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
                className="mt-8 grid md:grid-cols-2 gap-8 max-w-5xl mx-auto"
            >
                <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-8 backdrop-blur-sm">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Character Orientation</h3>
                    <div className="flex gap-4">
                        {(['video', 'image'] as const).map((opt) => (
                            <button
                                key={opt}
                                onClick={() => setCharacterOrientation(opt)}
                                className={`flex-1 py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-300 ${characterOrientation === opt
                                    ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-[0_0_15px_-3px_rgba(168,85,247,0.3)]'
                                    : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                    }`}
                            >
                                {opt === 'video' ? 'Follow Video' : 'Follow Image'}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-8 backdrop-blur-sm">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Quality Mode</h3>
                    <div className="flex gap-4">
                        <button
                            onClick={() => setMode('720p')}
                            className={`flex-1 py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-300 ${mode === '720p'
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-[0_0_15px_-3px_rgba(168,85,247,0.3)]'
                                : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                }`}
                        >
                            Standard (720p)
                        </button>
                        <button
                            onClick={() => setMode('1080p')}
                            className={`flex-1 relative py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-300 overflow-hidden group ${mode === '1080p'
                                ? 'bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-pink-300 border border-pink-500/50 shadow-[0_0_15px_-3px_rgba(236,72,153,0.3)]'
                                : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                }`}
                        >
                            <span className="relative z-10">Pro (1080p)</span>
                            {mode !== '1080p' && <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-pink-500/10 opacity-0 group-hover:opacity-100 transition-opacity" />}
                        </button>
                    </div>
                </div>

                <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-8 md:col-span-2 backdrop-blur-sm">
                    <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Prompt Configuration</h3>
                    <EnhancePromptButton
                        prompt={prompt}
                        onEnhanced={(text) => setPrompt(text)}
                        onCreditsUpdate={(c) => setUserCredits(c)}
                        medium="motion"
                        selectedModel={selectedModel}
                        context={{ modelId: selectedModel, characterOrientation, mode }}
                        disabled={isGenerating}
                    />
                    <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="e.g., The cartoon character is dancing happily..."
                        maxLength={2500}
                        className="w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 focus:border-purple-500/50 focus:ring-4 focus:ring-purple-500/10 outline-none resize-y min-h-[120px] placeholder:text-zinc-600 transition-all text-sm leading-relaxed"
                    />
                    <p className="text-xs text-zinc-600 mt-2">{prompt.length}/2500 characters</p>
                </div>
            </motion.div>

            {/* Duration and Cost Display */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="mt-8 flex flex-col gap-4 items-center"
            >
                {(() => {
                    const creditsPerSec = selectedModel === 'kling-3.0' 
                        ? (mode === '1080p' ? 20 : 12) 
                        : (mode === '1080p' ? 9 : 6);
                    const estimatedCost = duration > 0 ? Math.ceil(duration * creditsPerSec) : 0;
                    
                    return duration > 0 ? (
                        <div className="bg-purple-900/10 border border-purple-500/20 rounded-2xl p-6 text-center w-full max-w-md shadow-[0_0_30px_-10px_rgba(168,85,247,0.15)] flex flex-col items-center justify-center">
                            <div className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400 mb-1">
                                {estimatedCost} Credits
                            </div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Estimated Cost</p>
                            <div className="h-[1px] w-12 bg-zinc-800 mb-2" />
                            <p className="text-sm text-zinc-400">
                                Based on {duration.toFixed(1)}s video at {creditsPerSec} credits/sec
                            </p>
                        </div>
                    ) : (
                        <div className="bg-zinc-900/20 border border-white/5 rounded-2xl p-6 text-center w-full max-w-md backdrop-blur-sm">
                            <p className="text-zinc-500 text-sm">Upload a video to see cost estimation.</p>
                        </div>
                    );
                })()}
            </motion.div>

            {/* Generate Button and Progress Bar */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="mt-8 flex flex-col items-center gap-4 w-full max-w-2xl mx-auto"
            >
                {(() => {
                    const creditsPerSec = selectedModel === 'kling-3.0' 
                        ? (mode === '1080p' ? 20 : 12) 
                        : (mode === '1080p' ? 9 : 6);
                    const estimatedCost = duration > 0 ? Math.ceil(duration * creditsPerSec) : 0;
                    const hasEnoughCredits = userCredits !== null && estimatedCost > 0 && userCredits >= estimatedCost;
                    const insufficientCredits = userCredits !== null && estimatedCost > 0 && userCredits < estimatedCost;

                    return (
                        <>
                            {insufficientCredits ? (
                                <div className="flex flex-col items-center gap-4 px-6 py-6 bg-gradient-to-b from-purple-500/10 to-pink-500/10 border border-purple-500/20 rounded-2xl w-full max-w-md">
                                    <div className="flex items-center gap-2">
                                        <Sparkles className="w-5 h-5 text-yellow-400" />
                                        <p className="text-base font-semibold text-white">Not enough credits</p>
                                    </div>
                                    <p className="text-sm text-zinc-400 text-center">This video costs <strong className="text-white">{estimatedCost} credits</strong> but you only have <strong className="text-white">{userCredits} credits</strong>.</p>
                                    <Link href="/pricing" className="px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-full transition-all flex items-center gap-2 hover:opacity-90 hover:scale-105 font-semibold text-sm shadow-[0_0_20px_-5px_rgba(168,85,247,0.4)]">
                                        <Sparkles className="w-4 h-4" />Top Up Credits
                                    </Link>
                                </div>
                            ) : (
                                <>
                                    <button
                                        onClick={handleGenerate}
                                        disabled={(!characterImage && !characterImageFile) || (!referenceVideo && !referenceVideoFile) || isGenerating || !hasEnoughCredits}
                                        className="flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-600 rounded-full font-medium text-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed w-full justify-center"
                                    >
                                        {isGenerating ? (
                                            <><Loader2 className="w-5 h-5 animate-spin" />Generating...</>
                                        ) : (
                                            <><Sparkles className="w-5 h-5" />Generate Video ({duration > 0 ? `${Math.ceil(duration)}s` : ''})</>
                                        )}
                                    </button>
                                    {duration > 0 && !isGenerating && (
                                        <p className="text-xs text-zinc-500">Cost: {estimatedCost} Credits</p>
                                    )}
                                </>
                            )}
                        </>
                    );
                })()}

                {/* Progress Bar */}
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
                        <p className="text-xs text-zinc-600 text-center pt-2">Estimated time: ~3-5 minutes. You can safely close or refresh this page.</p>
                    </div>
                )}

                {error === '__TIMEOUT_INFO__' && (
                    <div className="flex flex-col items-center gap-3 px-5 py-4 bg-teal-500/10 border border-teal-500/20 rounded-xl mt-4 text-center">
                        <p className="text-sm text-teal-300 font-semibold">⏳ Your video is still being generated!</p>
                        <p className="text-xs text-zinc-400">This generation is taking longer than usual. Your video will automatically appear in <Link href="/creations" className="text-purple-400 underline hover:text-purple-300">My Creations</Link> once it&apos;s ready.</p>
                    </div>
                )}

                {error && error !== '__TIMEOUT_INFO__' && !error.toLowerCase().includes('insufficient') && (
                    <div className="flex flex-col items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl mt-4">
                        <p className="text-sm text-red-400 text-center">{error}</p>
                    </div>
                )}

                {error && error.toLowerCase().includes('insufficient') && (
                    <div className="flex flex-col items-center gap-4 px-6 py-6 bg-gradient-to-b from-purple-500/10 to-pink-500/10 border border-purple-500/20 rounded-2xl mt-4 max-w-md w-full">
                        <div className="flex items-center gap-2">
                            <Sparkles className="w-5 h-5 text-yellow-400" />
                            <p className="text-base font-semibold text-white">You&apos;re out of credits!</p>
                        </div>
                        <p className="text-sm text-zinc-400 text-center">Top up your credits to continue creating amazing videos.</p>
                        <Link href="/pricing" className="px-8 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-full transition-all flex items-center gap-2 hover:opacity-90 hover:scale-105 font-semibold text-sm shadow-[0_0_20px_-5px_rgba(168,85,247,0.4)]">
                            <Sparkles className="w-4 h-4" />Top Up Credits
                        </Link>
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
                        <video src={outputVideo} controls autoPlay loop className="w-full" />
                    </div>
                    <a
                        href={outputVideo}
                        download="generated-video.mp4"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 rounded-full font-medium transition-colors"
                    >
                        <Download className="w-5 h-5" />Download Video
                    </a>
                </motion.div>
            )}
        </div>
    );
}
