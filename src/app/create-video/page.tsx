'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Sparkles, Loader2, Download, X, Image as ImageIcon, Video, Plus, Trash2, Volume2, VolumeX, Play, Camera, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { getVideoCost, VIDEO_MODELS, VideoModelId } from '@/lib/models';

interface MultiShot {
    id: string;
    prompt: string;
    duration: number;
}

interface VideoWorkflowSettings {
    model?: VideoModelId;
    isMultiShot?: boolean;
    multiPrompts?: MultiShot[];
    mode?: string;
    aspectRatio?: string;
    sound?: boolean;
    duration?: number;
    resolution?: string;
    fixedLens?: boolean;
}

export default function CreateVideoPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-zinc-500" /></div>}>
            <CreateVideoContent />
        </Suspense>
    );
}

function CreateVideoContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const remixId = searchParams.get('remix');
    const prefillPrompt = searchParams.get('prompt');
    const prefillModel = searchParams.get('model');
    const prefillAspectRatio = searchParams.get('aspectRatio');
    const prefillDuration = searchParams.get('duration');

    const [isLoadingUser, setIsLoadingUser] = useState(true);
    const [userCredits, setUserCredits] = useState<number | null>(null);

    const [selectedModel, setSelectedModel] = useState<VideoModelId>('kling-3.0-video');
    const [isMultiShot, setIsMultiShot] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [singleDuration, setSingleDuration] = useState(5);
    const [multiPrompts, setMultiPrompts] = useState<MultiShot[]>([
        { id: '1', prompt: '', duration: 5 },
    ]);
    const [startImageFile, setStartImageFile] = useState<File | null>(null);
    const [startImageUrl, setStartImageUrl] = useState<string | null>(null);
    const [endImageFile, setEndImageFile] = useState<File | null>(null);
    const [endImageUrl, setEndImageUrl] = useState<string | null>(null);
    const [mode, setMode] = useState('std');
    const [aspectRatio, setAspectRatio] = useState('16:9');
    const [sound, setSound] = useState(false);
    const [resolution, setResolution] = useState('720p');
    const [fixedLens, setFixedLens] = useState(false);

    const [isDraggingStart, setIsDraggingStart] = useState(false);
    const [isDraggingEnd, setIsDraggingEnd] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const modelDropdownRef = useRef<HTMLDivElement>(null);

    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);
    const [remixVideoUrl, setRemixVideoUrl] = useState<string | null>(null);
    const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);

    useEffect(() => {
        if (remixId) return;
        if (prefillPrompt) setPrompt(prefillPrompt);
        if (prefillModel && prefillModel in VIDEO_MODELS) setSelectedModel(prefillModel as VideoModelId);
        if (prefillAspectRatio) setAspectRatio(prefillAspectRatio);
        if (prefillDuration) {
            const nextDuration = Number(prefillDuration);
            if (!Number.isNaN(nextDuration)) setSingleDuration(nextDuration);
        }
    }, [prefillPrompt, prefillModel, prefillAspectRatio, prefillDuration, remixId]);

    const videoModel = VIDEO_MODELS[selectedModel];
    const currentMode = videoModel.modeOptions.length > 0 && videoModel.modeOptions.some((option) => option.value === mode)
        ? mode
        : (videoModel.modeOptions[0]?.value || '');
    const currentAspectRatio = (videoModel.aspectRatios as readonly string[]).includes(aspectRatio)
        ? aspectRatio
        : videoModel.aspectRatios[0];
    const currentResolution = videoModel.resolutions.length > 0 && (videoModel.resolutions as readonly string[]).includes(resolution)
        ? resolution
        : (videoModel.resolutions[0] || '');
    const currentDuration = (videoModel.durations as readonly number[]).includes(singleDuration)
        ? singleDuration
        : videoModel.durations[0];
    const currentSound = videoModel.supportsSound ? sound : false;
    const currentFixedLens = videoModel.supportsFixedLens ? fixedLens : false;
    const currentIsMultiShot = videoModel.supportsMultiShot ? isMultiShot : false;
    const totalDuration = currentIsMultiShot
        ? multiPrompts.reduce((acc, curr) => acc + curr.duration, 0)
        : (videoModel.provider === 'veo' ? videoModel.durations[0] : currentDuration);
    const estimatedCost = getVideoCost(selectedModel, {
        mode: currentMode,
        sound: currentSound,
        durationSeconds: totalDuration,
        resolution: currentResolution,
    });
    const insufficientCredits = userCredits !== null && userCredits < estimatedCost;

    useEffect(() => {
        const checkUser = async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) {
                    router.push('/login?returnUrl=/create-video');
                    return;
                }
                setIsLoadingUser(false);
                const { data: profile } = await supabase.from('profiles').select('credits').eq('id', user.id).single();
                if (profile) setUserCredits(profile.credits);
            } catch {
                router.push('/login?returnUrl=/create-video');
            }
        };
        checkUser();
    }, [router]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
                setIsModelDropdownOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (videoModel.modeOptions?.length) {
            if (!videoModel.modeOptions.some((option) => option.value === mode)) {
                setMode(videoModel.modeOptions[0].value);
            }
        } else if (mode !== '') {
            setMode('');
        }

        if (!(videoModel.aspectRatios as readonly string[]).includes(aspectRatio)) {
            setAspectRatio(videoModel.aspectRatios[0]);
        }

        if (!(videoModel.durations as readonly number[]).includes(singleDuration)) {
            setSingleDuration(videoModel.durations[0]);
        }

        if (videoModel.resolutions?.length) {
            if (!(videoModel.resolutions as readonly string[]).includes(resolution)) {
                setResolution(videoModel.resolutions[0]);
            }
        } else if (resolution !== '') {
            setResolution('');
        }

        if (!videoModel.supportsSound) {
            setSound(false);
        }

        if (!videoModel.supportsFixedLens) {
            setFixedLens(false);
        }

        if (!videoModel.supportsMultiShot) {
            setIsMultiShot(false);
        }
    }, [selectedModel, videoModel, mode, aspectRatio, singleDuration, resolution]);

    useEffect(() => {
        if (!remixId) return;

        const fetchRemixData = async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;

            try {
                const { data, error } = await supabase
                    .from('generations')
                    .select('title, prompt, workflow_settings, output_url')
                    .eq('id', remixId)
                    .single();

                if (error || !data) {
                    console.error('Failed to load remix data');
                    return;
                }

                if (data.title) setRemixTitle(data.title);

                try {
                    const sessionData = await supabase.auth.getSession();
                    const token = sessionData.data.session?.access_token;
                    if (token) {
                        const previewRes = await fetch(`/api/showcase/preview?id=${remixId}`, {
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        if (previewRes.ok) {
                            const previewData = await previewRes.json();
                            if (previewData.url) setRemixVideoUrl(previewData.url);
                        }
                    }
                } catch (previewError) {
                    console.error('Failed to load preview URL:', previewError);
                }

                const settings = data.workflow_settings as VideoWorkflowSettings | null;
                if (settings?.model && settings.model in VIDEO_MODELS) {
                    setSelectedModel(settings.model);
                }

                if (settings) {
                    if (settings.isMultiShot !== undefined) {
                        setIsMultiShot(settings.isMultiShot);
                        if (settings.isMultiShot && settings.multiPrompts) {
                            setMultiPrompts(settings.multiPrompts.map((shot, index) => ({
                                id: shot.id || `${index + 1}`,
                                prompt: shot.prompt,
                                duration: shot.duration,
                            })));
                        } else {
                            if (data.prompt) setPrompt(data.prompt);
                            if (settings.duration) setSingleDuration(settings.duration);
                        }
                    } else {
                        if (data.prompt) setPrompt(data.prompt);
                        if (settings.duration) setSingleDuration(settings.duration);
                    }

                    if (settings.mode) setMode(settings.mode);
                    if (settings.aspectRatio) setAspectRatio(settings.aspectRatio);
                    if (settings.sound !== undefined) setSound(settings.sound);
                    if (settings.resolution) setResolution(settings.resolution);
                    if (settings.fixedLens !== undefined) setFixedLens(settings.fixedLens);
                } else if (data.prompt) {
                    setPrompt(data.prompt);
                }
            } catch (fetchError) {
                console.error('Error fetching remix:', fetchError);
            } finally {
                setIsRemixLoading(false);
            }
        };

        fetchRemixData();
    }, [remixId]);

    const addShot = () => {
        setMultiPrompts([...multiPrompts, { id: Math.random().toString(), prompt: '', duration: 5 }]);
    };

    const removeShot = (id: string) => {
        if (multiPrompts.length > 1) {
            setMultiPrompts(multiPrompts.filter((shot) => shot.id !== id));
        }
    };

    const updateShot = (id: string, field: 'prompt' | 'duration', value: string | number) => {
        setMultiPrompts(multiPrompts.map((shot) => shot.id === id ? { ...shot, [field]: value } : shot));
    };

    const handleImageDrop = (event: React.DragEvent, type: 'start' | 'end') => {
        event.preventDefault();
        if (type === 'start') {
            setIsDraggingStart(false);
        } else {
            setIsDraggingEnd(false);
        }

        const file = event.dataTransfer.files?.[0];
        if (file && file.type.startsWith('image/')) {
            if (type === 'start') {
                setStartImageFile(file);
                setStartImageUrl(URL.createObjectURL(file));
            } else {
                setEndImageFile(file);
                setEndImageUrl(URL.createObjectURL(file));
            }
        }
    };

    const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>, type: 'start' | 'end') => {
        const file = event.target.files?.[0];
        if (file && file.type.startsWith('image/')) {
            if (type === 'start') {
                setStartImageFile(file);
                setStartImageUrl(URL.createObjectURL(file));
            } else {
                setEndImageFile(file);
                setEndImageUrl(URL.createObjectURL(file));
            }
            event.target.value = '';
        }
    };

    const clearImage = (event: React.MouseEvent, type: 'start' | 'end') => {
        event.preventDefault();
        if (type === 'start') {
            setStartImageFile(null);
            setStartImageUrl(null);
        } else {
            setEndImageFile(null);
            setEndImageUrl(null);
        }
    };

    const uploadToSupabase = async (file: File): Promise<string> => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Please log in to upload files.');

        const fileExt = file.name.split('.').pop();
        const fileName = `${user.id}/${Math.random().toString(36).substring(2)}.${fileExt}`;
        const { error: uploadError } = await supabase.storage.from('uploads').upload(fileName, file);
        if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

        const { data: signedData, error: signedUrlError } = await supabase.storage
            .from('uploads')
            .createSignedUrl(fileName, 3600);

        if (signedUrlError || !signedData?.signedUrl) {
            throw new Error(`Signed URL generation failed: ${signedUrlError?.message || 'Unknown error'}`);
        }

        return signedData.signedUrl;
    };

    const pollPrediction = async (predictionId: string, accessToken: string): Promise<string> => {
        const maxAttempts = 120;
        let attempts = 0;
        const startTime = Date.now();

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate-video?id=${predictionId}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            const data = await response.json();

            if (data.status === 'succeeded') return data.output;
            if (data.status === 'failed') throw new Error(data.error || 'Video generation failed');

            const elapsed = (Date.now() - startTime) / 1000;
            const progress = Math.min((elapsed / 300) * 90, 95);

            let statusMsg = 'Processing...';
            if (progress < 10) statusMsg = 'Queuing request...';
            else if (progress < 40) statusMsg = 'Warming up AI models...';
            else if (progress < 80) statusMsg = 'Rendering video frames...';
            else statusMsg = 'Finalizing export...';

            setGenerationStatus(`${statusMsg} (${Math.round(progress)}%)`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error('Video generation timed out.');
    };

    const handleSelectModel = (modelId: VideoModelId) => {
        const nextModel = VIDEO_MODELS[modelId];

        setSelectedModel(modelId);
        setIsModelDropdownOpen(false);
        setMode(nextModel.modeOptions[0]?.value || '');
        setAspectRatio(nextModel.aspectRatios[0]);
        setSingleDuration(nextModel.durations[0]);
        setResolution(nextModel.resolutions[0] || '');
        setSound(false);
        setFixedLens(false);

        if (!nextModel.supportsMultiShot) {
            setIsMultiShot(false);
        }
    };

    const handleGenerate = async () => {
        if (isMultiShot) {
            if (multiPrompts.some((shot) => !shot.prompt.trim())) {
                setError('All shots must have a prompt');
                return;
            }
        } else if (!prompt.trim()) {
            setError('Please enter a prompt');
            return;
        }

        if (insufficientCredits) {
            setError(`Insufficient credits. This costs ${estimatedCost} credits.`);
            return;
        }

        setIsGenerating(true);
        setError(null);
        setOutputVideo(null);
        setGenerationStatus('Preparing... (0%)');

        try {
            let startUrl: string | null = null;
            let endUrl: string | null = null;

            if (startImageFile) {
                setGenerationStatus('Uploading start image... (2%)');
                startUrl = await uploadToSupabase(startImageFile);
            }

            if (endImageFile && !isMultiShot) {
                setGenerationStatus('Uploading end image... (4%)');
                endUrl = await uploadToSupabase(endImageFile);
            }

            setGenerationStatus('Starting AI generation... (5%)');

            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                router.push('/login?returnUrl=/create-video');
                return;
            }

            const payload = {
                model: selectedModel,
                isMultiShot: currentIsMultiShot,
                prompt: prompt.trim(),
                multiPrompts,
                duration: totalDuration,
                startImageUrl: startUrl,
                endImageUrl: endUrl,
                mode: currentMode,
                aspectRatio: currentAspectRatio,
                sound: currentSound,
                resolution: currentResolution,
                fixedLens: currentFixedLens,
            };

            const response = await fetch('/api/generate-video', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify(payload),
            });

            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Failed to start generation');

            const outputUrl = await pollPrediction(data.predictionId, session.access_token);
            setOutputVideo(outputUrl);
            setGenerationStatus('Video generated successfully! (100%)');
            if (data.remainingCredits !== undefined) setUserCredits(data.remainingCredits);
        } catch (generationError) {
            setError(generationError instanceof Error ? generationError.message : 'Something went wrong');
            setGenerationStatus(null);
        } finally {
            setIsGenerating(false);
        }
    };

    const getProgress = () => {
        if (!generationStatus) return 0;
        const match = generationStatus.match(/\((\d+)%\)/);
        return match ? parseInt(match[1]) : 0;
    };

    if (isLoadingUser) {
        return (
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-black text-white p-6 sm:p-8 font-[family-name:var(--font-geist-sans)]">
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[10%] left-[-10%] w-[40%] h-[40%] bg-blue-900/15 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/10 blur-[120px] rounded-full mix-blend-screen" />
            </div>

            <div className="relative z-10 max-w-5xl mx-auto">
                <div className="flex items-center gap-4 mb-8">
                    <Link href="/create" className="group p-3 rounded-full bg-zinc-900/50 border border-white/5 hover:bg-zinc-800 hover:border-white/10 transition-all backdrop-blur-md">
                        <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">Video Generation</h1>
                        <p className="text-sm text-zinc-500 font-medium tracking-wide">{videoModel.displayName.toUpperCase()}</p>
                    </div>
                    {userCredits !== null && (
                        <div className="ml-auto flex items-center gap-2 px-4 py-2 bg-zinc-900/50 border border-white/5 rounded-full backdrop-blur-md">
                            <Sparkles className="w-4 h-4 text-purple-400" />
                            <span className="text-sm font-semibold text-white">{userCredits}</span>
                            <span className="text-xs text-zinc-500 hidden sm:inline">credits</span>
                        </div>
                    )}
                </div>

                <AnimatePresence>
                    {remixId && !isRemixLoading && (
                        <motion.div
                            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                            animate={{ opacity: 1, height: 'auto', marginBottom: 32 }}
                            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                            className="bg-purple-900/20 border border-purple-500/30 rounded-2xl p-4 flex items-center justify-between overflow-hidden backdrop-blur-md"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-purple-500/20 rounded-full">
                                    <Sparkles className="w-5 h-5 text-purple-400" />
                                </div>
                                <div>
                                    <h3 className="font-semibold text-purple-100 text-sm">Remixing Community Creation</h3>
                                    <p className="text-xs text-purple-300/80">
                                        Settings pre-filled from {remixTitle ? `"${remixTitle}"` : 'the original creation'}.
                                    </p>
                                </div>
                            </div>

                            {remixVideoUrl && (
                                <button
                                    onClick={() => setIsPreviewModalOpen(true)}
                                    className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 rounded-xl transition-colors text-sm font-medium text-purple-300"
                                >
                                    <Play className="w-4 h-4" />
                                    View Original
                                </button>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                <div className="grid lg:grid-cols-12 gap-8">
                    <div className="lg:col-span-8 flex flex-col gap-6">
                        <motion.div
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="relative"
                            ref={modelDropdownRef}
                        >
                            <p className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Video Model</p>
                            <button
                                onClick={() => setIsModelDropdownOpen((prev) => !prev)}
                                className="w-full flex items-center justify-between gap-3 px-5 py-4 bg-zinc-900/50 border border-white/10 rounded-2xl hover:bg-zinc-900/70 hover:border-white/15 transition-all backdrop-blur-sm"
                            >
                                <div className="flex items-center gap-3">
                                    <Video className="w-4 h-4 text-white" />
                                    <div className="text-left">
                                        <div className="text-sm font-bold text-white">{videoModel.displayName}</div>
                                        <p className="text-xs text-zinc-500 mt-0.5">{videoModel.description}</p>
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
                                        {(Object.values(VIDEO_MODELS) as typeof VIDEO_MODELS[VideoModelId][]).map((modelOption) => {
                                            const isActive = selectedModel === modelOption.id;

                                            return (
                                                <button
                                                    key={modelOption.id}
                                                    onClick={() => handleSelectModel(modelOption.id)}
                                                    className={`w-full text-left px-5 py-4 flex items-center gap-3 transition-all ${isActive ? 'bg-white/5' : 'hover:bg-white/[0.03]'}`}
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <span className={`text-sm font-bold ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                                                            {modelOption.displayName}
                                                        </span>
                                                        <p className="text-xs text-zinc-500 mt-0.5">{modelOption.description}</p>
                                                        <div className="flex flex-wrap gap-1.5 mt-2">
                                                            {modelOption.supportsMultiShot && (
                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20">
                                                                    Multi-shot
                                                                </span>
                                                            )}
                                                            {modelOption.supportsSound && (
                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                                                                    Sound
                                                                </span>
                                                            )}
                                                            {modelOption.supportsFixedLens && (
                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
                                                                    Fixed Lens
                                                                </span>
                                                            )}
                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-white/5">
                                                                {modelOption.durations.length > 1
                                                                    ? `${modelOption.durations.join('/')}s`
                                                                    : `${modelOption.durations[0]}s fixed`}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    {isActive && <Check className="w-4 h-4 text-blue-400 shrink-0" />}
                                                </button>
                                            );
                                        })}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </motion.div>

                        {videoModel.supportsMultiShot && (
                            <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-2 flex gap-2 backdrop-blur-sm self-start">
                                <button
                                    onClick={() => setIsMultiShot(false)}
                                    className={`px-6 py-2.5 rounded-2xl text-sm font-bold transition-all ${!currentIsMultiShot ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                    Single Shot
                                </button>
                                <button
                                    onClick={() => setIsMultiShot(true)}
                                    className={`px-6 py-2.5 rounded-2xl text-sm font-bold transition-all ${currentIsMultiShot ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                    Multi-Shot
                                </button>
                            </div>
                        )}

                        <AnimatePresence mode="popLayout">
                            {!currentIsMultiShot ? (
                                <motion.div
                                    key="single-shot"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ duration: 0.2 }}
                                    className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm"
                                >
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Video Prompt</h2>
                                    <EnhancePromptButton
                                        prompt={prompt}
                                        onEnhanced={(text) => setPrompt(text)}
                                        onCreditsUpdate={(credits) => setUserCredits(credits)}
                                        medium="video"
                                        selectedModel={videoModel.enhancerModelId}
                                        context={{ modelId: selectedModel, mode: currentMode, aspectRatio: currentAspectRatio, duration: totalDuration, sound: currentSound, resolution: currentResolution }}
                                        disabled={isGenerating}
                                    />
                                    <textarea
                                        value={prompt}
                                        onChange={(event) => setPrompt(event.target.value)}
                                        placeholder={`Describe the ${videoModel.displayName} scene in rich cinematic detail...`}
                                        maxLength={2500}
                                        className="w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 focus:border-blue-500/50 focus:ring-4 focus:ring-blue-500/10 outline-none resize-y min-h-[140px] text-sm leading-relaxed"
                                    />
                                    <div className="mt-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <span className="text-xs text-zinc-500 font-medium">Duration:</span>
                                            {videoModel.durations.length > 1 ? (
                                                videoModel.durations.map((durationOption) => (
                                                    <button
                                                        key={durationOption}
                                                        onClick={() => setSingleDuration(durationOption)}
                                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${currentDuration === durationOption ? 'bg-white/10 text-white border border-white/20' : 'bg-black text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                                    >
                                                        {durationOption} sec
                                                    </button>
                                                ))
                                            ) : (
                                                <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white border border-white/20">
                                                    {videoModel.durations[0]} sec fixed
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-xs text-zinc-600">{prompt.length}/2500</span>
                                    </div>
                                </motion.div>
                            ) : (
                                <motion.div
                                    key="multi-shot"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ duration: 0.2 }}
                                    className="flex flex-col gap-4"
                                >
                                    <AnimatePresence>
                                        {multiPrompts.map((shot, index) => (
                                            <motion.div
                                                key={shot.id}
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: 'auto' }}
                                                exit={{ opacity: 0, height: 0 }}
                                                className="bg-zinc-900/30 border border-purple-500/20 rounded-3xl p-6 backdrop-blur-sm relative group"
                                            >
                                                <div className="flex justify-between items-center mb-3">
                                                    <h2 className="text-xs font-bold text-purple-400 uppercase tracking-widest">Shot {index + 1}</h2>
                                                    {multiPrompts.length > 1 && (
                                                        <button onClick={() => removeShot(shot.id)} className="text-zinc-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    )}
                                                </div>
                                                <EnhancePromptButton
                                                    prompt={shot.prompt}
                                                    onEnhanced={(text) => updateShot(shot.id, 'prompt', text)}
                                                    onCreditsUpdate={(credits) => setUserCredits(credits)}
                                                    medium="video"
                                                    selectedModel={videoModel.enhancerModelId}
                                                    context={{ modelId: selectedModel, mode: currentMode, aspectRatio: currentAspectRatio, duration: shot.duration, sound: currentSound, shotIndex: index }}
                                                    disabled={isGenerating}
                                                />
                                                <textarea
                                                    value={shot.prompt}
                                                    onChange={(event) => updateShot(shot.id, 'prompt', event.target.value)}
                                                    placeholder={`Describe shot ${index + 1}...`}
                                                    className="w-full bg-black/50 text-white rounded-2xl p-4 border border-white/10 focus:border-purple-500/50 outline-none resize-none min-h-[100px] text-sm mb-4"
                                                />
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xs text-zinc-500 font-medium">Duration (1-12s):</span>
                                                    <input
                                                        type="range"
                                                        min="1"
                                                        max="12"
                                                        step="1"
                                                        value={shot.duration}
                                                        onChange={(event) => updateShot(shot.id, 'duration', parseInt(event.target.value))}
                                                        className="w-32 accent-purple-500"
                                                    />
                                                    <span className="text-xs font-bold text-white">{shot.duration}s</span>
                                                </div>
                                            </motion.div>
                                        ))}
                                    </AnimatePresence>

                                    <button
                                        onClick={addShot}
                                        className="w-full py-4 border-2 border-dashed border-zinc-800 rounded-3xl text-zinc-500 font-medium flex items-center justify-center gap-2 hover:border-purple-500/50 hover:text-purple-400 hover:bg-purple-500/5 transition-all"
                                    >
                                        <Plus className="w-5 h-5" /> Add New Shot
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <div className="grid sm:grid-cols-2 gap-4">
                            <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm">
                                <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                                    Start Frame <span className="text-[10px] text-zinc-600 normal-case">optional</span>
                                </h2>
                                <label
                                    className={`group flex flex-col items-center justify-center w-full h-[140px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDraggingStart ? 'border-cyan-400 bg-cyan-500/10' : 'border-zinc-700/50 hover:border-cyan-500/50'}`}
                                    onDragOver={(event) => { event.preventDefault(); setIsDraggingStart(true); }}
                                    onDragLeave={(event) => { event.preventDefault(); setIsDraggingStart(false); }}
                                    onDrop={(event) => handleImageDrop(event, 'start')}
                                >
                                    {startImageUrl ? (
                                        <div className="w-full h-full relative">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={startImageUrl} alt="Start frame" className="w-full h-full object-cover" />
                                            <button onClick={(event) => clearImage(event, 'start')} className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-red-500 text-white rounded-full"><X className="w-3 h-3" /></button>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center gap-2 text-zinc-500"><ImageIcon className="w-6 h-6" /><span className="text-xs">Upload Reference Image</span></div>
                                    )}
                                    <input type="file" accept="image/*" onChange={(event) => handleImageUpload(event, 'start')} className="hidden" />
                                </label>
                            </div>

                            {!currentIsMultiShot && (
                                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm">
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                                        End Frame <span className="text-[10px] text-zinc-600 normal-case">optional</span>
                                    </h2>
                                    <label
                                        className={`group flex flex-col items-center justify-center w-full h-[140px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDraggingEnd ? 'border-cyan-400 bg-cyan-500/10' : 'border-zinc-700/50 hover:border-cyan-500/50'}`}
                                        onDragOver={(event) => { event.preventDefault(); setIsDraggingEnd(true); }}
                                        onDragLeave={(event) => { event.preventDefault(); setIsDraggingEnd(false); }}
                                        onDrop={(event) => handleImageDrop(event, 'end')}
                                    >
                                        {endImageUrl ? (
                                            <div className="w-full h-full relative">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={endImageUrl} alt="End frame" className="w-full h-full object-cover" />
                                                <button onClick={(event) => clearImage(event, 'end')} className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-red-500 text-white rounded-full"><X className="w-3 h-3" /></button>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center gap-2 text-zinc-500"><ImageIcon className="w-6 h-6" /><span className="text-xs">Upload End Image</span></div>
                                        )}
                                        <input type="file" accept="image/*" onChange={(event) => handleImageUpload(event, 'end')} className="hidden" />
                                    </label>
                                </motion.div>
                            )}
                        </div>
                    </div>

                    <div className="lg:col-span-4 flex flex-col gap-6">
                        <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm space-y-6">
                            {videoModel.modeOptions.length > 0 && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">{selectedModel === 'veo-3.1' ? 'Model Variant' : 'Quality Mode'}</h2>
                                    <div className="flex flex-col gap-2">
                                        {videoModel.modeOptions.map((option) => (
                                            <button
                                                key={option.value}
                                                onClick={() => setMode(option.value)}
                                                className={`p-3 rounded-xl text-sm font-medium transition-all text-left ${currentMode === option.value ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {videoModel.resolutions.length > 0 && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Resolution</h2>
                                    <div className="grid grid-cols-3 gap-2">
                                        {videoModel.resolutions.map((resolutionOption) => (
                                            <button
                                                key={resolutionOption}
                                                onClick={() => setResolution(resolutionOption)}
                                                className={`py-2 rounded-xl text-xs font-bold transition-all ${currentResolution === resolutionOption ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                            >
                                                {resolutionOption}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div>
                                <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Aspect Ratio</h2>
                                <div className="grid grid-cols-3 gap-2">
                                    {videoModel.aspectRatios.map((ratio) => (
                                        <button
                                            key={ratio}
                                            onClick={() => setAspectRatio(ratio)}
                                            className={`py-2 rounded-xl text-xs font-bold transition-all ${currentAspectRatio === ratio ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                        >
                                            {ratio}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {videoModel.supportsFixedLens && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Camera</h2>
                                    <button
                                        onClick={() => setFixedLens(!fixedLens)}
                                        className={`w-full p-3 rounded-xl flex items-center justify-between text-sm font-medium transition-all ${currentFixedLens ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-black/50 text-zinc-500 border border-white/5'}`}
                                    >
                                        <span className="flex items-center gap-2">
                                            <Camera className="w-4 h-4" />
                                            Fixed Lens
                                        </span>
                                        <span>{currentFixedLens ? 'ON' : 'OFF'}</span>
                                    </button>
                                </div>
                            )}

                            {videoModel.supportsSound && (
                                <div>
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Audio</h2>
                                    <button
                                        onClick={() => setSound(!sound)}
                                        className={`w-full p-3 rounded-xl flex items-center justify-between text-sm font-medium transition-all ${currentSound ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-black/50 text-zinc-500 border border-white/5'}`}
                                    >
                                        <span className="flex items-center gap-2">
                                            {currentSound ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                                            AI Sound Effects
                                        </span>
                                        <span>{currentSound ? 'ON' : 'OFF'}</span>
                                    </button>
                                </div>
                            )}
                        </div>

                        <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm">
                            <div className="flex justify-between items-end mb-6">
                                <div>
                                    <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-1">Total Cost</p>
                                    <div className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400 flex items-baseline gap-2">
                                        {estimatedCost} <span className="text-sm text-zinc-500 font-medium">credits</span>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs text-zinc-500">Duration</p>
                                    <p className="text-lg font-bold text-white">{totalDuration}s</p>
                                </div>
                            </div>

                            {insufficientCredits ? (
                                <Link href="/pricing" className="w-full py-4 bg-zinc-800 text-white rounded-xl flex justify-center items-center gap-2 font-bold hover:bg-zinc-700 transition-all opacity-80">
                                    <Sparkles className="w-4 h-4 text-yellow-500" />
                                    Top Up Credits
                                </Link>
                            ) : (
                                <button
                                    onClick={handleGenerate}
                                    disabled={isGenerating}
                                    className="w-full py-4 bg-gradient-to-r from-blue-600 to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl flex justify-center items-center gap-2 font-bold text-white shadow-[0_0_20px_-5px_rgba(59,130,246,0.3)] hover:shadow-[0_0_30px_-5px_rgba(59,130,246,0.5)] transition-all"
                                >
                                    {isGenerating ? <><Loader2 className="w-5 h-5 animate-spin" /> Generating...</> : <><Video className="w-5 h-5" /> Generate Video</>}
                                </button>
                            )}

                            {isGenerating && generationStatus && (
                                <div className="mt-4 space-y-2">
                                    <div className="flex justify-between text-xs text-blue-300 font-medium px-1">
                                        <span>{generationStatus}</span>
                                        <span>{getProgress()}%</span>
                                    </div>
                                    <div className="h-1.5 bg-black rounded-full overflow-hidden">
                                        <motion.div
                                            className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
                                            initial={{ width: '0%' }}
                                            animate={{ width: `${getProgress()}%` }}
                                            transition={{ duration: 0.5 }}
                                        />
                                    </div>
                                </div>
                            )}

                            {error && <p className="mt-4 text-xs text-red-400 text-center bg-red-400/10 py-2 rounded-lg">{error}</p>}
                        </div>
                    </div>
                </div>

                {outputVideo && (
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mt-12 bg-zinc-900/30 border border-green-500/20 rounded-3xl p-6 backdrop-blur-sm flex flex-col items-center">
                        <h2 className="text-xl font-bold text-green-400 mb-6 flex items-center gap-2">
                            <Sparkles className="w-5 h-5" /> Your Video is Ready!
                        </h2>
                        <div className="w-full max-w-3xl rounded-2xl overflow-hidden bg-black aspect-video flex items-center justify-center border border-white/10 shadow-2xl">
                            <video src={outputVideo} controls autoPlay loop className="w-full h-full object-contain" />
                        </div>
                        <a href={outputVideo} download="generated_video.mp4" target="_blank" rel="noopener noreferrer" className="mt-6 px-8 py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-full flex items-center gap-2 transition-all">
                            <Download className="w-4 h-4" /> Download Video
                        </a>
                    </motion.div>
                )}
            </div>

            <AnimatePresence>
                {isPreviewModalOpen && remixVideoUrl && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
                        onClick={() => setIsPreviewModalOpen(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0, y: 20 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.95, opacity: 0, y: 20 }}
                            onClick={(event) => event.stopPropagation()}
                            className="bg-zinc-900 border border-white/10 p-6 rounded-3xl max-w-2xl w-full flex flex-col gap-6 shadow-2xl relative"
                        >
                            <button
                                onClick={() => setIsPreviewModalOpen(false)}
                                className="absolute top-4 right-4 p-2 z-10 bg-black/50 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>

                            <h2 className="text-xl font-bold bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">
                                Original Creation
                            </h2>

                            <div className="rounded-xl overflow-hidden border border-white/5 bg-black/50 flex items-center justify-center flex-1 min-h-[300px] relative group">
                                <video
                                    src={remixVideoUrl}
                                    controls
                                    autoPlay
                                    loop
                                    className="max-h-[60vh] object-contain rounded-xl w-full"
                                />
                            </div>

                            <div className="bg-black/40 p-4 rounded-2xl border border-white/5 flex flex-col gap-2">
                                <div className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Prompt</div>
                                <p className="text-sm text-zinc-300 leading-relaxed max-h-32 overflow-y-auto pr-2 custom-scrollbar">
                                    {isMultiShot ? multiPrompts.map((shot) => shot.prompt).join(' | ') : prompt || 'No prompt available'}
                                </p>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
