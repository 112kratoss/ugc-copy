'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Loader2, Download, X, Image as ImageIcon, Video, Plus, Trash2, Volume2, VolumeX, Play, Camera, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    GeneratorPageHeader,
    MediaStudioShell,
    StudioRemixNotice,
    StudioRunPanel,
    StudioWorkspacePanel,
} from '@/app/components/CreatorStudio';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { clampVideoDuration, getDefaultVideoDuration, getVideoCost, getVideoDurationRange, isValidVideoDuration, VIDEO_MODELS, VideoModelId } from '@/lib/models';
import { useAuth } from '@/app/components/AuthProvider';

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

export interface CreateVideoPrefill {
    remixId?: string | null;
    prompt?: string | null;
    model?: string | null;
    aspectRatio?: string | null;
    duration?: string | null;
}

export default function CreateVideoClient({ prefill }: { prefill: CreateVideoPrefill }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, updateCredits } = useAuth();
    const remixId = prefill.remixId ?? null;
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const prefillAspectRatio = prefill.aspectRatio ?? null;
    const prefillDuration = prefill.duration ?? null;

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
    const singleShotDurationRange = getVideoDurationRange(selectedModel);
    const currentDuration = clampVideoDuration(selectedModel, singleDuration);
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

        if (!isValidVideoDuration(selectedModel, singleDuration)) {
            setSingleDuration(getDefaultVideoDuration(selectedModel));
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
        setSingleDuration(getDefaultVideoDuration(modelId));
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
                sourceGenerationId: remixId || undefined,
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
            if (data.remainingCredits !== undefined) updateCredits(data.remainingCredits);
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

    const workspaceTitle = outputVideo
        ? 'Latest video result'
        : isGenerating
            ? 'Creating your video'
            : remixVideoUrl
                ? 'Remix reference loaded'
                : 'Ready to build a scene';

    const workspaceDescription = outputVideo
        ? 'Your newest video stays here until you start another run.'
        : isGenerating
            ? 'Track the active run here while the model handles timing, frames, and render.'
            : remixVideoUrl
                ? 'Use the original clip as working context while you update prompt, shots, and settings.'
                : 'The workspace will show the current run and latest result once you generate.';

    return (
        <div className="min-h-screen bg-black py-6 text-white sm:py-8 font-[family-name:var(--font-geist-sans)]">
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[10%] left-[-10%] w-[40%] h-[40%] bg-blue-900/15 blur-[120px] rounded-full mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/10 blur-[120px] rounded-full mix-blend-screen" />
            </div>

            <MediaStudioShell
                currentToolId="video"
                header={
                    <GeneratorPageHeader
                        currentToolId="video"
                        title="Create video"
                        eyebrow={`Creator studio / ${videoModel.displayName}`}
                        description="Start with video when the idea needs movement, presence, or a clearer story in the very first output."
                        credits={userCredits}
                        showPathSwitcher={false}
                    />
                }
                controls={
                    <>
                        <AnimatePresence>
                            {remixId && !isRemixLoading && (
                                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}>
                                    <StudioRemixNotice
                                        description={`Settings pre-filled from ${remixTitle ? `"${remixTitle}"` : 'the original creation'}.`}
                                        action={
                                            remixVideoUrl ? (
                                                <button
                                                    onClick={() => setIsPreviewModalOpen(true)}
                                                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                                                >
                                                    <Play className="h-4 w-4" />
                                                    View original
                                                </button>
                                            ) : undefined
                                        }
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>

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
                                            const modelOptionDurationRange = getVideoDurationRange(modelOption.id);

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
                                                                {modelOptionDurationRange
                                                                    ? `${modelOptionDurationRange.min}-${modelOptionDurationRange.max}s`
                                                                    : (modelOption.durations.length > 1
                                                                        ? `${modelOption.durations.join('/')}s`
                                                                        : `${modelOption.durations[0]}s fixed`)}
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
                                        onCreditsUpdate={updateCredits}
                                        medium="video"
                                        selectedModel={videoModel.enhancerModelId}
                                        context={{
                                            modelId: selectedModel,
                                            mode: currentMode,
                                            aspectRatio: currentAspectRatio,
                                            duration: totalDuration,
                                            sound: currentSound,
                                            resolution: currentResolution,
                                            isMultiShot: currentIsMultiShot,
                                            shotCount: multiPrompts.length,
                                            hasStartImage: Boolean(startImageFile || startImageUrl),
                                            hasEndImage: Boolean(endImageFile || endImageUrl),
                                        }}
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
                                            {singleShotDurationRange ? (
                                                <>
                                                    <input
                                                        type="range"
                                                        min={singleShotDurationRange.min}
                                                        max={singleShotDurationRange.max}
                                                        step="1"
                                                        value={currentDuration}
                                                        onChange={(event) => setSingleDuration(Number(event.target.value))}
                                                        className="w-36 accent-blue-500"
                                                    />
                                                    <span className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 text-white border border-white/20">
                                                        {currentDuration} sec
                                                    </span>
                                                    <span className="text-xs text-zinc-600">
                                                        {singleShotDurationRange.min}-{singleShotDurationRange.max}s
                                                    </span>
                                                </>
                                            ) : videoModel.durations.length > 1 ? (
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
                                                    onCreditsUpdate={updateCredits}
                                                    medium="video"
                                                    selectedModel={videoModel.enhancerModelId}
                                                    context={{
                                                        modelId: selectedModel,
                                                        mode: currentMode,
                                                        aspectRatio: currentAspectRatio,
                                                        duration: shot.duration,
                                                        sound: currentSound,
                                                        shotIndex: index,
                                                        isMultiShot: currentIsMultiShot,
                                                        shotCount: multiPrompts.length,
                                                        hasStartImage: Boolean(startImageFile || startImageUrl),
                                                        hasEndImage: Boolean(endImageFile || endImageUrl),
                                                    }}
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
                    </>
                }
                workspace={
                    <>
                        <StudioRunPanel
                            title={isGenerating ? 'Video run in progress' : 'Ready to generate'}
                            summary={
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Model</div>
                                        <div className="mt-2 text-sm font-semibold text-white">{videoModel.displayName}</div>
                                    </div>
                                    <div className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Cost</div>
                                        <div className="mt-2 text-sm font-semibold text-white">{estimatedCost} credits</div>
                                    </div>
                                </div>
                            }
                            details={
                                <div className="grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Duration</div>
                                        <div className="mt-1 text-zinc-200">{totalDuration}s</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Aspect ratio</div>
                                        <div className="mt-1 text-zinc-200">{currentAspectRatio}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Shot mode</div>
                                        <div className="mt-1 text-zinc-200">{currentIsMultiShot ? 'Multi-shot' : 'Single shot'}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Credits left</div>
                                        <div className="mt-1 text-zinc-200">{userCredits ?? '...'}</div>
                                    </div>
                                </div>
                            }
                            action={
                                insufficientCredits ? (
                                    <div className="space-y-4">
                                        <div className="rounded-[22px] border border-rose-500/20 bg-rose-500/10 p-4">
                                            <p className="text-sm font-semibold text-white">Not enough credits</p>
                                            <p className="mt-2 text-sm text-zinc-400">
                                                This run costs <strong className="text-white">{estimatedCost} credits</strong> but you only have <strong className="text-white">{userCredits}</strong>.
                                            </p>
                                        </div>
                                        <Link href="/pricing" className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90">
                                            <Sparkles className="h-4 w-4" />
                                            Top Up Credits
                                        </Link>
                                    </div>
                                ) : (
                                    <button
                                        onClick={handleGenerate}
                                        disabled={isGenerating}
                                        className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-4 text-base font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90"
                                    >
                                        {isGenerating ? <><Loader2 className="w-5 h-5 animate-spin" /> Generating...</> : <><Video className="w-5 h-5" /> Generate Video</>}
                                    </button>
                                )
                            }
                            status={
                                <>
                                    {isGenerating && generationStatus ? (
                                        <div className="space-y-3">
                                            <div className="flex justify-between text-sm text-zinc-300">
                                                <span>{generationStatus}</span>
                                                <span>{getProgress()}%</span>
                                            </div>
                                            <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                                                <motion.div
                                                    className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
                                                    initial={{ width: '0%' }}
                                                    animate={{ width: `${getProgress()}%` }}
                                                    transition={{ duration: 0.5 }}
                                                />
                                            </div>
                                            <p className="text-xs text-zinc-500">Longer runs can take a few minutes.</p>
                                        </div>
                                    ) : error ? (
                                        <p className="text-sm text-red-400">{error}</p>
                                    ) : (
                                        <p className="text-sm text-zinc-500">The current run will replace this workspace as soon as generation starts.</p>
                                    )}
                                </>
                            }
                            footer={
                                <Link
                                    href="/creations"
                                    className="inline-flex items-center gap-2 text-sm font-medium text-zinc-300 transition hover:text-white"
                                >
                                    View My Creations
                                    <Download className="h-4 w-4" />
                                </Link>
                            }
                        />

                        <StudioWorkspacePanel
                            title={workspaceTitle}
                            description={workspaceDescription}
                            action={
                                <Link
                                    href="/creations"
                                    className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-100 transition hover:bg-white/[0.06]"
                                >
                                    My Creations
                                    <Download className="h-4 w-4" />
                                </Link>
                            }
                        >
                            {outputVideo ? (
                                <div className="space-y-5">
                                    <div className="overflow-hidden rounded-[26px] border border-white/8 bg-black/60 aspect-video">
                                        <video src={outputVideo} controls autoPlay loop className="h-full w-full object-contain" />
                                    </div>
                                    <a href={outputVideo} download="generated_video.mp4" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500">
                                        <Download className="h-4 w-4" />
                                        Download video
                                    </a>
                                </div>
                            ) : isGenerating ? (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-blue-500/30 to-purple-500/20">
                                        <Loader2 className="h-7 w-7 animate-spin text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">Rendering the current scene</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            This workspace will switch from progress to preview as soon as the model finishes the latest run.
                                        </p>
                                    </div>
                                </div>
                            ) : remixVideoUrl ? (
                                <div className="space-y-5">
                                    <div className="overflow-hidden rounded-[26px] border border-white/8 bg-black/60 aspect-video">
                                        <video src={remixVideoUrl} controls autoPlay loop className="h-full w-full object-contain" />
                                    </div>
                                    <button
                                        onClick={() => setIsPreviewModalOpen(true)}
                                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                    >
                                        <Play className="h-4 w-4" />
                                        View original
                                    </button>
                                </div>
                            ) : (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-blue-500/30 to-purple-500/20">
                                        <Video className="h-7 w-7 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">No video yet</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            Choose the shot structure, write the prompt, and set your frames. The latest render will take over this workspace.
                                        </p>
                                    </div>
                                </div>
                            )}
                        </StudioWorkspacePanel>
                    </>
                }
            >
            </MediaStudioShell>

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
