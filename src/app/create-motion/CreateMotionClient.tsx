'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Upload, Sparkles, Loader2, Download, Zap, ChevronDown, Check, Play, Share2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import {
    StudioBackgroundProcessingNotice,
    GeneratorPageHeader,
    MediaStudioShell,
    StudioControlCard,
    StudioMediaPreviewModal,
    StudioRemixNotice,
    StudioRunPanel,
    StudioUploadedMediaPreview,
    StudioWorkspacePanel,
} from '@/app/components/CreatorStudio';
import PublicShareButton from '@/app/components/PublicShareButton';
import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { useAuth } from '@/app/components/AuthProvider';
import { buildShowcaseDetailPath } from '@/lib/share';
import {
    getPersistedFile,
    PERSISTED_MEDIA_KEYS,
    removePersistedMedia,
    setPersistedFile,
} from '@/lib/persisted-media';
import { BACKGROUND_PROCESSING_ERROR, getBackgroundProcessingCopy } from '@/lib/generation-feedback';

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

interface MotionWorkflowSettings {
    model?: ModelId;
    mode?: '720p' | '1080p';
    characterOrientation?: 'video' | 'image';
}

export interface CreateMotionPrefill {
    remixId?: string | null;
    prompt?: string | null;
    model?: string | null;
}

interface UploadPreviewState {
    type: 'image' | 'video';
    src: string;
    alt: string;
    title: string;
}

export default function CreateMotionClient({ prefill }: { prefill: CreateMotionPrefill }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, session, updateCredits } = useAuth();
    const [selectedModel, setSelectedModel] = useState<ModelId>('kling-3.0');
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const characterImageInputRef = useRef<HTMLInputElement>(null);
    const referenceVideoInputRef = useRef<HTMLInputElement>(null);

    const [characterImage, setCharacterImage] = useState<string | null>(null);
    const [characterImageFile, setCharacterImageFile] = useState<File | null>(null);
    const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
    const [referenceVideoFile, setReferenceVideoFile] = useState<File | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [videoError, setVideoError] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [latestGenerationId, setLatestGenerationId] = useState<string | null>(null);
    const [latestIsPublic, setLatestIsPublic] = useState(false);
    const [publishedMeta, setPublishedMeta] = useState<{ title: string; description: string } | null>(null);
    const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
    const [duration, setDuration] = useState<number>(0);
    const [characterOrientation, setCharacterOrientation] = useState<'video' | 'image'>('video');
    const [mode, setMode] = useState<'720p' | '1080p'>('720p');
    const [prompt, setPrompt] = useState<string>("No distortion, the character's movements are consistent with the video.");
    const [isDraggingImage, setIsDraggingImage] = useState(false);
    const [isDraggingVideo, setIsDraggingVideo] = useState(false);

    // Remix State
    const remixId = prefill.remixId ?? null;
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);
    const [remixVideoUrl, setRemixVideoUrl] = useState<string | null>(null);
    const [uploadPreview, setUploadPreview] = useState<UploadPreviewState | null>(null);

    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

    useEffect(() => {
        if (remixId) return;
        if (prefillPrompt) setPrompt(prefillPrompt);
        if (prefillModel && prefillModel in MOTION_MODELS) setSelectedModel(prefillModel as ModelId);
    }, [prefillPrompt, prefillModel, remixId]);

    const model = MOTION_MODELS[selectedModel];
    const revokeObjectUrl = (url: string | null) => {
        if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    };

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
        await setPersistedFile(PERSISTED_MEDIA_KEYS.createMotionCharacterImage, file);
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
        await setPersistedFile(PERSISTED_MEDIA_KEYS.createMotionReferenceVideo, file);
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

    const handleClearImage = async () => {
        setCharacterImageFile(null); setCharacterImage(null);
        await removePersistedMedia(PERSISTED_MEDIA_KEYS.createMotionCharacterImage);
    };

    const handleClearVideo = async () => {
        setReferenceVideoFile(null); setReferenceVideo(null);
        setDuration(0); setVideoError(null);
        await removePersistedMedia(PERSISTED_MEDIA_KEYS.createMotionReferenceVideo);
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

    // Handle Remix Pre-fill
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
                 if (data.prompt) setPrompt(data.prompt);
                 
                 // Handle the preview URL via server-side signed URL
                 try {
                     const session = await supabase.auth.getSession();
                     const token = session.data.session?.access_token;
                     if (token) {
                         const previewRes = await fetch(`/api/showcase/preview?id=${remixId}`, {
                             headers: { 'Authorization': `Bearer ${token}` }
                         });
                         if (previewRes.ok) {
                             const previewData = await previewRes.json();
                             if (previewData.url) setRemixVideoUrl(previewData.url);
                         }
                     }
                 } catch (e) {
                     console.error('Failed to load preview URL:', e);
                 }
                 
                 const settings = data.workflow_settings as MotionWorkflowSettings | null;
                 if (settings) {
                     if (settings.model && MOTION_MODELS[settings.model]) {
                         setSelectedModel(settings.model);
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
        return () => {
            revokeObjectUrl(characterImage);
            revokeObjectUrl(referenceVideo);
        };
    }, [characterImage, referenceVideo]);

    useEffect(() => {
        const loadSavedFiles = async () => {
            try {
                const savedImageFile = await getPersistedFile(PERSISTED_MEDIA_KEYS.createMotionCharacterImage);
                if (savedImageFile) { setCharacterImageFile(savedImageFile); setCharacterImage(URL.createObjectURL(savedImageFile)); }
                const savedVideoFile = await getPersistedFile(PERSISTED_MEDIA_KEYS.createMotionReferenceVideo);
                if (savedVideoFile) { setReferenceVideoFile(savedVideoFile); setReferenceVideo(URL.createObjectURL(savedVideoFile)); }
            } catch (err) { console.error("Error loading persisted media:", err); }
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

        throw new Error(BACKGROUND_PROCESSING_ERROR);
    };

    const handleGenerate = async () => {
        if (!characterImageFile && !characterImage) { alert('Please upload a character image'); return; }
        if (!referenceVideoFile && !referenceVideo) { alert('Please upload a reference video'); return; }
        const effectiveDuration = Math.ceil(duration);
        if (effectiveDuration <= 0) { alert('Invalid video duration'); return; }

        setIsGenerating(true); setError(null); setOutputVideo(null);
        setLatestGenerationId(null); setLatestIsPublic(false); setPublishedMeta(null);

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
                    prompt,
                    sourceGenerationId: remixId || undefined,
                })
            });

            const data = await response.json();
            if (!data.success) {
                const errorMessage = data.details
                    ? `${data.error}: ${data.details} (Code: ${data.code})`
                    : (data.error || 'Failed to start generation');
                throw new Error(errorMessage);
            }
            setLatestGenerationId(data.generationId ?? null);
            setLatestIsPublic(false);

            const outputUrl = await pollPrediction(data.predictionId, session.access_token);
            setOutputVideo(outputUrl);
            setGenerationStatus('Video generated successfully! (100%)');

        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Something went wrong';
            if (msg === BACKGROUND_PROCESSING_ERROR) {
                setGenerationStatus(getBackgroundProcessingCopy('motion').status);
                setError(BACKGROUND_PROCESSING_ERROR);
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

    const creditsPerSecond = selectedModel === 'kling-3.0'
        ? (mode === '1080p' ? 20 : 12)
        : (mode === '1080p' ? 9 : 6);
    const estimatedCost = duration > 0 ? Math.ceil(duration * creditsPerSecond) : 0;
    const insufficientCredits = userCredits !== null && estimatedCost > 0 && userCredits < estimatedCost;
    const canGenerate = Boolean(characterImage || characterImageFile)
        && Boolean(referenceVideo || referenceVideoFile)
        && duration > 0
        && !videoError;
    const isBackgroundProcessing = error === BACKGROUND_PROCESSING_ERROR;
    const backgroundProcessingCopy = getBackgroundProcessingCopy('motion');

    const workspaceTitle = outputVideo
        ? 'Latest motion result'
        : isGenerating
            ? 'Animating your character'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.title
            : 'Ready to transfer motion';

    const workspaceDescription = outputVideo
        ? 'Your newest motion render stays here until you start another run.'
        : isGenerating
            ? 'Track the active generation here while the model maps movement and finishes the clip.'
            : isBackgroundProcessing
                ? backgroundProcessingCopy.description
            : 'Upload a character still and a motion reference. The active run and latest result will take over this workspace.';
    const shareTitle = publishedMeta?.title || prompt.trim() || `${model.displayName} motion clip`;
    const shareDescription = publishedMeta?.description || prompt.trim() || null;
    const publicResultPath = latestGenerationId && latestIsPublic ? buildShowcaseDetailPath(latestGenerationId) : null;

    return (
        <div className="min-h-screen bg-black py-6 text-white sm:py-8 font-[family-name:var(--font-geist-sans)]">
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[8%] left-[-10%] h-[40%] w-[40%] rounded-full bg-violet-900/15 blur-[120px] mix-blend-screen" />
                <div className="absolute bottom-[-10%] right-[-10%] h-[44%] w-[44%] rounded-full bg-fuchsia-900/10 blur-[140px] mix-blend-screen" />
            </div>

            <MediaStudioShell
                currentToolId="motion"
                header={
                    <GeneratorPageHeader
                        currentToolId="motion"
                        title="Create motion"
                        eyebrow={`Creator studio / ${model.displayName}`}
                        description="Upload the character, match it to reference movement, and let the workspace track the active motion render from setup to final clip."
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
                                                <a
                                                    href={remixVideoUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                                                >
                                                    <Play className="h-4 w-4" />
                                                    View original
                                                </a>
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
                            ref={dropdownRef}
                        >
                            <StudioControlCard title="Motion model" description="Choose the engine and quality ceiling for this run.">
                                <button
                                    onClick={() => setIsModelDropdownOpen((prev) => !prev)}
                                    className="w-full flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/40 px-4 py-4 text-left transition hover:border-white/15 hover:bg-black/55"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-violet-400/20 bg-violet-400/10 text-violet-100">
                                            <Zap className="h-4 w-4" />
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold text-white">{model.displayName}</span>
                                                <span className={`rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white ${model.badgeColor}`}>
                                                    {model.badge}
                                                </span>
                                            </div>
                                            <p className="mt-1 text-sm text-zinc-400">{model.description}</p>
                                        </div>
                                    </div>
                                    <ChevronDown className={`h-4 w-4 text-zinc-400 transition-transform ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
                                </button>

                                <AnimatePresence>
                                    {isModelDropdownOpen && (
                                        <motion.div
                                            initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                            animate={{ opacity: 1, y: 0, scaleY: 1 }}
                                            exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
                                            transition={{ duration: 0.15 }}
                                            className="absolute z-50 mt-2 w-full overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl"
                                            style={{ transformOrigin: 'top' }}
                                        >
                                            {(Object.values(MOTION_MODELS) as typeof MOTION_MODELS[ModelId][]).map((motionModel) => {
                                                const isActive = selectedModel === motionModel.id;

                                                return (
                                                    <button
                                                        key={motionModel.id}
                                                        onClick={() => {
                                                            setSelectedModel(motionModel.id as ModelId);
                                                            setIsModelDropdownOpen(false);
                                                        }}
                                                        className={`flex w-full items-center gap-3 px-5 py-4 text-left transition ${isActive ? 'bg-white/5' : 'hover:bg-white/[0.03]'}`}
                                                    >
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className={`text-sm font-semibold ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                                                                    {motionModel.displayName}
                                                                </span>
                                                                <span className={`rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white ${motionModel.badgeColor}`}>
                                                                    {motionModel.badge}
                                                                </span>
                                                            </div>
                                                            <p className="mt-1 text-sm text-zinc-400">{motionModel.description}</p>
                                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                                <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                                                                    Max {motionModel.maxVideoDuration}s
                                                                </span>
                                                                <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                                                                    720p / 1080p
                                                                </span>
                                                            </div>
                                                        </div>
                                                        {isActive ? <Check className="h-4 w-4 shrink-0 text-violet-300" /> : null}
                                                    </button>
                                                );
                                            })}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </StudioControlCard>
                        </motion.div>

                        <StudioControlCard
                            title="Character image"
                            description="A clear still works best. The model uses this as the identity anchor."
                            meta={<span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Step 1</span>}
                        >
                            {characterImage ? (
                                <div className="h-[280px]">
                                    <StudioUploadedMediaPreview
                                        mediaType="image"
                                        src={characterImage}
                                        alt="Character image"
                                        fit="contain"
                                        previewHint="Preview image"
                                        onPreview={() => setUploadPreview({
                                            type: 'image',
                                            src: characterImage,
                                            alt: 'Character image',
                                            title: 'Character Image',
                                        })}
                                        onReplace={() => characterImageInputRef.current?.click()}
                                        onRemove={() => void handleClearImage()}
                                    />
                                </div>
                            ) : (
                                <label
                                    htmlFor="motion-character-image-input"
                                    className={`group flex h-[280px] w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[24px] border-2 border-dashed bg-black/40 transition ${isDraggingImage
                                        ? 'border-violet-400 bg-violet-500/10 shadow-[0_0_30px_-5px_rgba(168,85,247,0.3)]'
                                        : 'border-zinc-700/50 hover:border-violet-500/50 hover:bg-violet-500/5'
                                        }`}
                                    onDragOver={(event) => handleDragOver(event, setIsDraggingImage)}
                                    onDragLeave={(event) => handleDragLeave(event, setIsDraggingImage)}
                                    onDrop={handleImageDrop}
                                >
                                    <div className="flex flex-col items-center gap-3 text-center text-zinc-500">
                                        <Upload className={`h-8 w-8 transition-colors ${isDraggingImage ? 'text-violet-300' : ''}`} />
                                        <div>
                                            <p className="text-sm font-medium text-zinc-300">
                                                {isDraggingImage ? 'Drop image here' : 'Click or drag in the character image'}
                                            </p>
                                            <p className="mt-1 text-xs text-zinc-500">JPG, PNG, WEBP. Use a clean full-body frame when possible.</p>
                                        </div>
                                    </div>
                                </label>
                            )}
                            <input
                                ref={characterImageInputRef}
                                id="motion-character-image-input"
                                type="file"
                                accept="image/*"
                                onChange={handleImageUpload}
                                className="hidden"
                            />
                        </StudioControlCard>

                        <StudioControlCard
                            title="Reference video"
                            description="This clip drives the movement timing and overall energy."
                            meta={<span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Step 2</span>}
                        >
                            <div className="space-y-4">
                                {referenceVideo ? (
                                    <div className="h-[280px]">
                                        <StudioUploadedMediaPreview
                                            mediaType="video"
                                            src={referenceVideo}
                                            alt="Reference video"
                                            fit="contain"
                                            previewHint="Preview video"
                                            onPreview={() => setUploadPreview({
                                                type: 'video',
                                                src: referenceVideo,
                                                alt: 'Reference video',
                                                title: 'Reference Video',
                                            })}
                                            onReplace={() => referenceVideoInputRef.current?.click()}
                                            onRemove={() => void handleClearVideo()}
                                        />
                                    </div>
                                ) : (
                                    <label
                                        htmlFor="motion-reference-video-input"
                                        className={`group flex h-[280px] w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-[24px] border-2 border-dashed bg-black/40 transition ${isDraggingVideo
                                            ? 'border-fuchsia-400 bg-fuchsia-500/10 shadow-[0_0_30px_-5px_rgba(217,70,239,0.3)]'
                                            : 'border-zinc-700/50 hover:border-fuchsia-500/50 hover:bg-fuchsia-500/5'
                                            }`}
                                        onDragOver={(event) => handleDragOver(event, setIsDraggingVideo)}
                                        onDragLeave={(event) => handleDragLeave(event, setIsDraggingVideo)}
                                        onDrop={handleVideoDrop}
                                    >
                                        <div className="flex flex-col items-center gap-3 text-center text-zinc-500">
                                            <Upload className={`h-8 w-8 transition-colors ${isDraggingVideo ? 'text-fuchsia-300' : ''}`} />
                                            <div>
                                                <p className="text-sm font-medium text-zinc-300">
                                                    {isDraggingVideo ? 'Drop video here' : 'Click or drag in the motion reference'}
                                                </p>
                                                <p className="mt-1 text-xs text-zinc-500">MP4 or MOV, up to 100MB and {model.maxVideoDuration}s.</p>
                                            </div>
                                        </div>
                                    </label>
                                )}
                                <input
                                    ref={referenceVideoInputRef}
                                    id="motion-reference-video-input"
                                    type="file"
                                    accept="video/*"
                                    onChange={handleVideoUpload}
                                    className="hidden"
                                />

                                <div className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-white/8 bg-black/30 px-4 py-3 text-sm text-zinc-400">
                                    <span>{duration > 0 ? `Reference length: ${duration.toFixed(1)}s` : 'Reference length will appear after upload.'}</span>
                                    <span>Limit: {model.maxVideoDuration}s</span>
                                </div>

                                {videoError ? (
                                    <div className="rounded-[20px] border border-rose-500/20 bg-rose-500/10 px-4 py-3">
                                        <p className="text-sm text-rose-300">{videoError}</p>
                                    </div>
                                ) : null}
                            </div>
                        </StudioControlCard>

                        <StudioControlCard title="Prompt" description="Guide the performance, energy, and cleanup details for the transfer.">
                            <EnhancePromptButton
                                prompt={prompt}
                                onEnhanced={(text) => setPrompt(text)}
                                onCreditsUpdate={updateCredits}
                                medium="motion"
                                selectedModel={selectedModel}
                                context={{
                                    modelId: selectedModel,
                                    characterOrientation,
                                    mode,
                                    hasReferenceVideo: Boolean(referenceVideoFile || referenceVideo),
                                }}
                                disabled={isGenerating}
                            />
                            <textarea
                                value={prompt}
                                onChange={(event) => setPrompt(event.target.value)}
                                placeholder="Describe the kind of movement, pacing, and constraints you want to preserve."
                                maxLength={2500}
                                className="mt-3 min-h-[140px] w-full resize-y rounded-2xl border border-white/10 bg-black/50 p-5 text-sm leading-relaxed text-white outline-none transition focus:border-violet-500/50 focus:ring-4 focus:ring-violet-500/10"
                            />
                            <div className="mt-3 flex justify-end text-xs text-zinc-500">{prompt.length}/2500</div>
                        </StudioControlCard>

                        <StudioControlCard title="Output settings" description="Set how closely the result follows the reference and the fidelity you want.">
                            <div className="grid gap-5 sm:grid-cols-2">
                                <div>
                                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Character orientation</div>
                                    <div className="grid grid-cols-2 gap-2">
                                        {(['video', 'image'] as const).map((option) => (
                                            <button
                                                key={option}
                                                onClick={() => setCharacterOrientation(option)}
                                                className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${characterOrientation === option
                                                    ? 'border border-violet-500/30 bg-violet-500/15 text-violet-100'
                                                    : 'border border-white/8 bg-black/40 text-zinc-400 hover:bg-white/[0.05] hover:text-white'
                                                    }`}
                                            >
                                                {option === 'video' ? 'Follow video' : 'Favor image'}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div>
                                    <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Quality mode</div>
                                    <div className="grid grid-cols-2 gap-2">
                                        {(['720p', '1080p'] as const).map((quality) => (
                                            <button
                                                key={quality}
                                                onClick={() => setMode(quality)}
                                                className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${mode === quality
                                                    ? 'border border-fuchsia-500/30 bg-fuchsia-500/15 text-fuchsia-100'
                                                    : 'border border-white/8 bg-black/40 text-zinc-400 hover:bg-white/[0.05] hover:text-white'
                                                    }`}
                                            >
                                                {quality === '720p' ? 'Standard 720p' : 'Pro 1080p'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </StudioControlCard>
                    </>
                }
                workspace={
                    <>
                        <StudioRunPanel
                            title={isGenerating ? 'Motion run in progress' : 'Ready to animate'}
                            summary={
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="rounded-[20px] border border-white/8 bg-black/30 p-4">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Model</div>
                                        <div className="mt-2 text-sm font-semibold text-white">{model.displayName}</div>
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
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Reference</div>
                                        <div className="mt-1 text-zinc-200">{duration > 0 ? `${duration.toFixed(1)}s` : 'Not loaded'}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Quality</div>
                                        <div className="mt-1 text-zinc-200">{mode}</div>
                                    </div>
                                    <div>
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Orientation</div>
                                        <div className="mt-1 text-zinc-200">{characterOrientation === 'video' ? 'Follow video' : 'Favor image'}</div>
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
                                        <Link href="/pricing" className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90">
                                            <Sparkles className="h-4 w-4" />
                                            Top Up Credits
                                        </Link>
                                    </div>
                                ) : (
                                    <button
                                        onClick={handleGenerate}
                                        disabled={!canGenerate || isGenerating}
                                        className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 px-6 py-4 text-base font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {isGenerating ? (
                                            <>
                                                <Loader2 className="h-5 w-5 animate-spin" />
                                                Generating...
                                            </>
                                        ) : (
                                            <>
                                                <Sparkles className="h-5 w-5" />
                                                Generate motion
                                            </>
                                        )}
                                    </button>
                                )
                            }
                            status={
                                <>
                                    {isGenerating && generationStatus ? (
                                        <div className="space-y-3">
                                            <div className="flex justify-between text-sm text-zinc-300">
                                                <span>{generationStatus}</span>
                                                <span>{getProgressPercentage()}%</span>
                                            </div>
                                            <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                                                <motion.div
                                                    className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
                                                    initial={{ width: '0%' }}
                                                    animate={{ width: `${getProgressPercentage()}%` }}
                                                    transition={{ duration: 0.5 }}
                                                />
                                            </div>
                                            <p className="text-xs text-zinc-500">Estimated time: about 3 to 5 minutes.</p>
                                        </div>
                                    ) : isBackgroundProcessing ? (
                                        <StudioBackgroundProcessingNotice accent="violet" label="motion render" />
                                    ) : videoError ? (
                                        <p className="text-sm text-rose-300">{videoError}</p>
                                    ) : error ? (
                                        <p className="text-sm text-rose-300">{error}</p>
                                    ) : (
                                        <p className="text-sm text-zinc-500">Upload both inputs, confirm the orientation, and the latest motion render will replace this workspace.</p>
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
                                    <div className="aspect-video overflow-hidden rounded-[26px] border border-white/8 bg-black/60">
                                        <video src={outputVideo} controls autoPlay loop className="h-full w-full object-contain" />
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        <a
                                            href={outputVideo}
                                            download="generated-video.mp4"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
                                        >
                                            <Download className="h-4 w-4" />
                                            Download video
                                        </a>
                                        {latestGenerationId ? (
                                            latestIsPublic ? (
                                                <>
                                                    <PublicShareButton
                                                        generationId={latestGenerationId}
                                                        title={shareTitle}
                                                        description={shareDescription}
                                                        sourceSurface="create-motion"
                                                        accessToken={session?.access_token ?? null}
                                                        className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                                    />
                                                    {publicResultPath ? (
                                                        <Link
                                                            href={publicResultPath}
                                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                                        >
                                                            Open public page
                                                        </Link>
                                                    ) : null}
                                                </>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => setIsPublishModalOpen(true)}
                                                    className="inline-flex items-center gap-2 rounded-full border border-purple-500/25 bg-purple-500/10 px-5 py-3 text-sm font-semibold text-purple-100 transition hover:border-purple-400/40 hover:bg-purple-500/15"
                                                >
                                                    <Share2 className="h-4 w-4" />
                                                    Publish & share
                                                </button>
                                            )
                                        ) : null}
                                        <button
                                            onClick={() => {
                                                setOutputVideo(null);
                                                setLatestGenerationId(null);
                                                setLatestIsPublic(false);
                                                setPublishedMeta(null);
                                                setError(null);
                                                setGenerationStatus(null);
                                            }}
                                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                                        >
                                            Start another run
                                        </button>
                                    </div>
                                </div>
                            ) : isGenerating ? (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-violet-500/30 to-fuchsia-500/20">
                                        <Loader2 className="h-7 w-7 animate-spin text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">Transferring the motion</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            The workspace will switch from progress to preview as soon as the current render finishes.
                                        </p>
                                    </div>
                                </div>
                            ) : isBackgroundProcessing ? (
                                <StudioBackgroundProcessingNotice accent="violet" label="motion render" variant="workspace" />
                            ) : (
                                <div className="flex min-h-[520px] flex-col items-center justify-center gap-5 rounded-[26px] border border-dashed border-white/10 bg-black/40 p-10 text-center">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-r from-violet-500/30 to-fuchsia-500/20">
                                        <Play className="h-7 w-7 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-semibold text-white">No motion run yet</h3>
                                        <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">
                                            Add the character image, the motion reference, and the prompt. The latest rendered clip will take over this workspace.
                                        </p>
                                    </div>
                                </div>
                            )}
                        </StudioWorkspacePanel>
                    </>
                }
            />

            <StudioMediaPreviewModal
                isOpen={Boolean(uploadPreview)}
                onClose={() => setUploadPreview(null)}
                mediaType={uploadPreview?.type ?? 'image'}
                src={uploadPreview?.src ?? null}
                alt={uploadPreview?.alt ?? 'Uploaded preview'}
                title={uploadPreview?.title ?? 'Media Preview'}
            />

            <PublishToShowcaseModal
                isOpen={isPublishModalOpen}
                onClose={() => setIsPublishModalOpen(false)}
                generationId={latestGenerationId}
                shareAfterPublish={latestGenerationId ? {
                    title: shareTitle,
                    description: shareDescription,
                    sourceSurface: 'create-motion',
                } : undefined}
                onPublished={(payload) => {
                    setLatestIsPublic(true);
                    setPublishedMeta(payload);
                    setIsPublishModalOpen(false);
                }}
            />
        </div>
    );
}
