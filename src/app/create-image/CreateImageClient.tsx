'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Sparkles, Loader2, Download, X, Image as ImageIcon, Zap, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import EnhancePromptButton from '@/app/components/EnhancePromptButton';
import { useAuth } from '@/app/components/AuthProvider';

// ─── Model Registry ─────────────────────────────────────────────────────────
const IMAGE_MODELS = {
    'nano-banana-2': {
        id: 'nano-banana-2',
        displayName: 'Nano Banana 2.0',
        description: 'Versatile image gen with Google Search grounding',
        badge: 'Recommended',
        badgeColor: 'from-blue-500 to-cyan-500',
        accentColor: 'blue',
        maxImages: 14,
        supportsGoogleSearch: true,
        aspectRatios: ['auto', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
        resolutions: ['1K', '2K', '4K'],
        outputFormats: ['jpg', 'png'],
    },
    'nano-banana-pro': {
        id: 'nano-banana-pro',
        displayName: 'Nano Banana Pro',
        description: 'High-fidelity generation with multi-image reference',
        badge: 'Pro',
        badgeColor: 'from-violet-500 to-purple-500',
        accentColor: 'violet',
        maxImages: 8,
        supportsGoogleSearch: false,
        aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto'],
        resolutions: ['1K', '2K', '4K'],
        outputFormats: ['jpg', 'png'],
    },
} as const;

type ModelId = keyof typeof IMAGE_MODELS;

interface ImageWorkflowSettings {
    model?: ModelId;
    aspectRatio?: string;
    resolution?: string;
    googleSearch?: boolean;
}

export interface CreateImagePrefill {
    remixId?: string | null;
    prompt?: string | null;
    model?: string | null;
    aspectRatio?: string | null;
}

export default function CreateImageClient({ prefill }: { prefill: CreateImagePrefill }) {
    const router = useRouter();
    const { credits: userCredits, isLoading: isLoadingUser, updateCredits } = useAuth();
    const [selectedModel, setSelectedModel] = useState<ModelId>('nano-banana-2');
    const [prompt, setPrompt] = useState('');
    const [referenceImages, setReferenceImages] = useState<{ url: string; file: File }[]>([]);
    const [aspectRatio, setAspectRatio] = useState('auto');
    const [resolution, setResolution] = useState('1K');
    const [googleSearch, setGoogleSearch] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [outputImage, setOutputImage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    
    // Remix State
    const remixId = prefill.remixId ?? null;
    const prefillPrompt = prefill.prompt ?? null;
    const prefillModel = prefill.model ?? null;
    const prefillAspectRatio = prefill.aspectRatio ?? null;
    const [isRemixLoading, setIsRemixLoading] = useState(!!remixId);
    const [remixTitle, setRemixTitle] = useState<string | null>(null);
    const [remixImageUrl, setRemixImageUrl] = useState<string | null>(null);
    const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);


    useEffect(() => {
        if (remixId) return;
        if (prefillPrompt) setPrompt(prefillPrompt);
        if (prefillModel && prefillModel in IMAGE_MODELS) setSelectedModel(prefillModel as ModelId);
        if (prefillAspectRatio) setAspectRatio(prefillAspectRatio);
    }, [prefillPrompt, prefillModel, prefillAspectRatio, remixId]);

    const model = IMAGE_MODELS[selectedModel];

    // When model changes, clamp images and aspect ratio
    useEffect(() => {
        setReferenceImages(prev => {
            if (prev.length > model.maxImages) {
                prev.slice(model.maxImages).forEach(img => URL.revokeObjectURL(img.url));
                return prev.slice(0, model.maxImages);
            }
            return prev;
        });
        if (!(model.aspectRatios as readonly string[]).includes(aspectRatio)) {
            setAspectRatio(model.aspectRatios[0]);
        }
        if (!model.supportsGoogleSearch) {
            setGoogleSearch(false);
        }
    }, [selectedModel]); // eslint-disable-line react-hooks/exhaustive-deps

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
                             if (previewData.url) setRemixImageUrl(previewData.url);
                         }
                     }
                 } catch (e) {
                     console.error('Failed to load preview URL:', e);
                 }
                 
                 const settings = data.workflow_settings as ImageWorkflowSettings | null;
                 if (settings) {
                     if (settings.model && IMAGE_MODELS[settings.model]) {
                         setSelectedModel(settings.model);
                     }
                     if (settings.aspectRatio) setAspectRatio(settings.aspectRatio);
                     if (settings.resolution) setResolution(settings.resolution);
                     if (settings.googleSearch !== undefined) setGoogleSearch(settings.googleSearch);
                 }
             } catch (err) {
                 console.error('Error fetching remix:', err);
             } finally {
                 setIsRemixLoading(false);
             }
        };

        fetchRemixData();
    }, [remixId]);

    const processImageFiles = (files: FileList | File[]) => {
        const validFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (validFiles.length === 0) return;

        const availableSlots = model.maxImages - referenceImages.length;
        const filesToAdd = validFiles.slice(0, availableSlots);

        const newImages = filesToAdd.map(file => ({
            url: URL.createObjectURL(file),
            file
        }));
        setReferenceImages(prev => [...prev, ...newImages]);
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.length) {
            processImageFiles(e.target.files);
            e.target.value = '';
        }
    };

    const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault(); setIsDragging(false);
        if (e.dataTransfer.files?.length) processImageFiles(e.dataTransfer.files);
    };

    const handleRemoveImage = (index: number, e: React.MouseEvent) => {
        e.preventDefault();
        setReferenceImages(prev => {
            const newImages = [...prev];
            URL.revokeObjectURL(newImages[index].url);
            newImages.splice(index, 1);
            return newImages;
        });
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
        const maxAttempts = 60; // 5 minutes max (5s intervals)
        let attempts = 0;
        const startTime = Date.now();

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate-image?id=${predictionId}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            const data = await response.json();

            if (data.status === 'succeeded') return data.output;
            if (data.status === 'failed') throw new Error(data.error || 'Image generation failed');

            const elapsed = (Date.now() - startTime) / 1000;
            const progress = Math.min((elapsed / 60) * 90, 90);

            let statusMsg = 'Processing...';
            if (progress < 20) statusMsg = 'Queuing request...';
            else if (progress < 60) statusMsg = 'Generating image...';
            else statusMsg = 'Finalizing...';

            setGenerationStatus(`${statusMsg} (${Math.round(progress)}%)`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }
        throw new Error('Image generation timed out. Please try again.');
    };

    const calculateCost = () => {
        if (selectedModel === 'nano-banana-pro') {
            if (resolution === '4K') return 24;
            return 18; // 1K and 2K are both 18 credits
        } else {
            // nano-banana-2
            if (resolution === '2K') return 12;
            if (resolution === '4K') return 18;
            return 8;
        }
    };
    const currentCost = calculateCost();
    const insufficientCredits = userCredits !== null && userCredits < currentCost;

    const handleGenerate = async () => {
        if (!prompt.trim()) { setError('Please enter a prompt'); return; }
        if (userCredits !== null && userCredits < currentCost) { setError(`Insufficient credits. Image generation costs ${currentCost} credits.`); return; }

        setIsGenerating(true);
        setError(null);
        setOutputImage(null);
        setGenerationStatus('Preparing... (0%)');

        try {
            let imageUrls: string[] = [];
            if (referenceImages.length > 0) {
                setGenerationStatus(`Uploading ${referenceImages.length} reference images... (2%)`);
                imageUrls = await Promise.all(referenceImages.map(img => uploadToSupabase(img.file)));
            }

            setGenerationStatus('Starting AI generation... (5%)');

            const { data: { session } } = await supabase.auth.getSession();
            if (!session) { router.push('/login?returnUrl=/create-image'); return; }

            const response = await fetch('/api/generate-image', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    model: selectedModel,
                    prompt: prompt.trim(),
                    imageUrls,
                    aspectRatio,
                    resolution,
                    googleSearch: model.supportsGoogleSearch ? googleSearch : false,
                    outputFormat: 'jpg',
                    sourceGenerationId: remixId || undefined,
                })
            });

            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Failed to start generation');

            const outputUrl = await pollPrediction(data.predictionId, session.access_token);
            setOutputImage(outputUrl);
            setGenerationStatus('Image generated successfully! (100%)');
            if (data.remainingCredits !== undefined) updateCredits(data.remainingCredits);

        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
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

    const accentStyles = {
        blue: {
            ring: 'focus:border-blue-500/50 focus:ring-blue-500/10',
            button: 'bg-blue-500/20 text-blue-300 border-blue-500/50 shadow-[0_0_12px_-3px_rgba(59,130,246,0.4)]',
            toggle: 'bg-blue-500',
            generate: 'from-blue-600 to-cyan-600 shadow-[0_0_30px_-8px_rgba(59,130,246,0.4)]',
            progress: 'from-blue-500 to-cyan-500',
        },
        violet: {
            ring: 'focus:border-violet-500/50 focus:ring-violet-500/10',
            button: 'bg-violet-500/20 text-violet-300 border-violet-500/50 shadow-[0_0_12px_-3px_rgba(139,92,246,0.4)]',
            toggle: 'bg-violet-500',
            generate: 'from-violet-600 to-purple-600 shadow-[0_0_30px_-8px_rgba(139,92,246,0.4)]',
            progress: 'from-violet-500 to-purple-500',
        },
    }[model.accentColor];

    if (isLoadingUser) {
        return (
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-black text-white p-8">
            {/* Background glows — animated per model */}
            <div className="fixed inset-0 z-0 pointer-events-none">
                <AnimatePresence mode="wait">
                    {selectedModel === 'nano-banana-2' ? (
                        <motion.div key="glow-nb2" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }}>
                            <div className="absolute top-[-20%] right-[-10%] w-[40%] h-[40%] bg-blue-900/15 blur-[120px] rounded-full mix-blend-screen" />
                            <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-cyan-900/10 blur-[120px] rounded-full mix-blend-screen" />
                        </motion.div>
                    ) : (
                        <motion.div key="glow-nbp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }}>
                            <div className="absolute top-[-20%] right-[-10%] w-[40%] h-[40%] bg-violet-900/15 blur-[120px] rounded-full mix-blend-screen" />
                            <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-900/10 blur-[120px] rounded-full mix-blend-screen" />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <div className="relative z-10 max-w-4xl mx-auto">
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
                            Image Generation
                        </h1>
                        <p className="text-sm text-zinc-500 font-medium tracking-wide">
                            AI IMAGE CREATOR · {model.displayName.toUpperCase()}
                        </p>
                    </div>
                    {userCredits !== null && (
                        <div className="ml-auto flex items-center gap-2 px-4 py-2 bg-zinc-900/50 border border-white/5 rounded-full backdrop-blur-md">
                            <Sparkles className="w-4 h-4 text-blue-400" />
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
                            
                            {remixImageUrl && (
                                <button
                                    onClick={() => setIsPreviewModalOpen(true)}
                                    className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 rounded-xl transition-colors text-sm font-medium text-purple-300"
                                >
                                    <ImageIcon className="w-4 h-4" />
                                    View Original
                                </button>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* ─── Model Selector (Dropdown) ────────────────────────────────── */}
                <motion.div
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-8 relative"
                    ref={dropdownRef}
                >
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
                                {(Object.values(IMAGE_MODELS) as typeof IMAGE_MODELS[ModelId][]).map((m) => {
                                    const isActive = selectedModel === m.id;
                                    return (
                                        <button
                                            key={m.id}
                                            onClick={() => {
                                                setSelectedModel(m.id as ModelId);
                                                setIsModelDropdownOpen(false);
                                            }}
                                            className={`w-full text-left px-5 py-4 flex items-center gap-3 transition-all ${
                                                isActive
                                                    ? 'bg-white/5'
                                                    : 'hover:bg-white/[0.03]'
                                            }`}
                                        >
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-sm font-bold ${isActive ? 'text-white' : 'text-zinc-300'}`}>
                                                        {m.displayName}
                                                    </span>
                                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r ${m.badgeColor} text-white`}>
                                                        {m.badge}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-zinc-500 mt-0.5">{m.description}</p>
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {m.supportsGoogleSearch && (
                                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                                            Google Search
                                                        </span>
                                                    )}
                                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 border border-white/5">
                                                        Up to {m.maxImages} ref images
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

                <div className="grid md:grid-cols-2 gap-8">
                    {/* Left Column: Prompt + Settings */}
                    <div className="flex flex-col gap-6">
                        {/* Prompt */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm"
                        >
                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                                <span className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center text-[10px] border border-blue-500/30">1</span>
                                Your Prompt
                            </h2>
                            <EnhancePromptButton
                                prompt={prompt}
                                onEnhanced={(text) => setPrompt(text)}
                                onCreditsUpdate={updateCredits}
                                medium="image"
                                selectedModel={selectedModel}
                                context={{
                                    modelId: selectedModel,
                                    aspectRatio,
                                    resolution,
                                    googleSearch,
                                    referenceImageCount: referenceImages.length,
                                }}
                                disabled={isGenerating}
                            />
                            <textarea
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                placeholder="Describe the image you want to create..."
                                maxLength={20000}
                                className={`w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 ${accentStyles.ring} focus:ring-4 outline-none resize-y min-h-[150px] placeholder:text-zinc-600 transition-all text-sm leading-relaxed`}
                            />
                            <p className="text-xs text-zinc-600 mt-2">{prompt.length}/20000 characters</p>
                        </motion.div>

                        {/* Aspect Ratio */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.05 }}
                            className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm"
                        >
                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Aspect Ratio</h2>
                            <div className="flex flex-wrap gap-2">
                                {model.aspectRatios.map(ratio => (
                                    <button
                                        key={ratio}
                                        onClick={() => setAspectRatio(ratio)}
                                        className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200 ${aspectRatio === ratio
                                            ? accentStyles.button + ' border'
                                            : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                            }`}
                                    >
                                        {ratio}
                                    </button>
                                ))}
                            </div>
                        </motion.div>

                        {/* Resolution */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.08 }}
                            className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm"
                        >
                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-4">Resolution</h2>
                            <div className="flex gap-3">
                                {model.resolutions.map(res => (
                                    <button
                                        key={res}
                                        onClick={() => setResolution(res)}
                                        className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-all duration-200 ${resolution === res
                                            ? accentStyles.button + ' border'
                                            : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800 hover:text-zinc-300'
                                            }`}
                                    >
                                        {res}
                                    </button>
                                ))}
                            </div>
                        </motion.div>
                    </div>

                    {/* Right Column: Optional settings + Generate */}
                    <div className="flex flex-col gap-6">
                        {/* Google Search Grounding — only for Nano Banana 2 */}
                        <AnimatePresence>
                            {model.supportsGoogleSearch && (
                                <motion.div
                                    key="google-search"
                                    initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.3 }}
                                    className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm overflow-hidden"
                                >
                                    <div className="flex items-center justify-between cursor-pointer" onClick={() => setGoogleSearch(!googleSearch)}>
                                        <div>
                                            <h2 className="text-sm font-bold text-white mb-1">Google Search Grounding</h2>
                                            <p className="text-xs text-zinc-500">Allow AI to access real-time internet info.</p>
                                        </div>
                                        <div className={`w-12 h-6 rounded-full p-1 transition-all ${googleSearch ? accentStyles.toggle : 'bg-zinc-800'}`}>
                                            <div className={`bg-white w-4 h-4 rounded-full shadow-md transition-transform ${googleSearch ? 'translate-x-6' : 'translate-x-0'}`} />
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Reference Images */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.06 }}
                            className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm"
                        >
                            <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-1 flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="w-5 h-5 rounded-full bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-[10px] border border-cyan-500/30">2</span>
                                    Reference Images
                                </div>
                                <span className="text-[10px] text-zinc-600 normal-case">
                                    {referenceImages.length}/{model.maxImages} uploaded
                                </span>
                            </h2>
                            <p className="text-sm text-zinc-500 mb-4">
                                Upload up to {model.maxImages} images to guide the style or content.
                            </p>

                            <div className="grid grid-cols-3 gap-2 mb-4">
                                {referenceImages.map((img, idx) => (
                                    <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-zinc-700/50 group">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={img.url} alt={`Reference ${idx + 1}`} className="w-full h-full object-cover" />
                                        <button
                                            onClick={(e) => handleRemoveImage(idx, e)}
                                            className="absolute top-1 right-1 p-1.5 bg-black/60 hover:bg-red-500 text-white rounded-full backdrop-blur-md opacity-0 group-hover:opacity-100 transition-all scale-75 group-hover:scale-100"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>

                            {referenceImages.length < model.maxImages && (
                                <label
                                    className={`group flex flex-col items-center justify-center w-full h-[120px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDragging
                                        ? 'border-cyan-400 bg-cyan-500/10 shadow-[0_0_30px_-5px_rgba(6,182,212,0.3)]'
                                        : 'border-zinc-700/50 hover:border-cyan-500/50 hover:bg-cyan-500/5'
                                        }`}
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                >
                                    <div className="flex flex-col items-center gap-2 text-zinc-500">
                                        <ImageIcon className={`w-6 h-6 transition-colors ${isDragging ? 'text-cyan-400' : ''}`} />
                                        <span className="text-sm">{isDragging ? 'Drop images here' : 'Drop images or click'}</span>
                                    </div>
                                    <input type="file" accept="image/*" multiple onChange={handleImageUpload} className="hidden" />
                                </label>
                            )}
                        </motion.div>

                        {/* Cost display */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 }}
                            className="bg-blue-900/10 border border-blue-500/20 rounded-2xl p-5 text-center shadow-[0_0_30px_-10px_rgba(59,130,246,0.15)]"
                        >
                            <div className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-cyan-400 mb-1">
                                {currentCost} Credits
                            </div>
                            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">For {resolution} Generation</p>
                            {userCredits !== null && (
                                <p className="text-xs text-zinc-500 mt-2">You have <span className="text-white font-semibold">{userCredits}</span> credits</p>
                            )}
                        </motion.div>

                        {/* Generate Button */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.12 }}
                            className="flex flex-col gap-4"
                        >
                            {insufficientCredits ? (
                                <div className="flex flex-col items-center gap-4 px-6 py-6 bg-gradient-to-b from-blue-500/10 to-cyan-500/10 border border-blue-500/20 rounded-2xl">
                                    <div className="flex items-center gap-2">
                                        <Sparkles className="w-5 h-5 text-yellow-400" />
                                        <p className="text-base font-semibold text-white">Not enough credits</p>
                                    </div>
                                    <p className="text-sm text-zinc-400 text-center">
                                        Image generation costs <strong className="text-white">{currentCost} credits</strong> but you only have <strong className="text-white">{userCredits} credits</strong>.
                                    </p>
                                    <Link href="/pricing" className="px-8 py-3 bg-gradient-to-r from-blue-600 to-cyan-600 text-white rounded-full flex items-center gap-2 hover:opacity-90 hover:scale-105 font-semibold text-sm transition-all shadow-[0_0_20px_-5px_rgba(59,130,246,0.4)]">
                                        <Sparkles className="w-4 h-4" />
                                        Top Up Credits
                                    </Link>
                                </div>
                            ) : (
                                <button
                                    onClick={handleGenerate}
                                    disabled={!prompt.trim() || isGenerating}
                                    className={`flex items-center gap-2 px-8 py-4 bg-gradient-to-r ${accentStyles.generate} rounded-full font-medium text-lg hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed w-full justify-center`}
                                >
                                    {isGenerating ? (
                                        <><Loader2 className="w-5 h-5 animate-spin" /> Generating...</>
                                    ) : (
                                        <><Sparkles className="w-5 h-5" /> Generate Image</>
                                    )}
                                </button>
                            )}

                            {/* Progress Bar */}
                            {isGenerating && generationStatus && (
                                <div className="space-y-2">
                                    <div className="flex justify-between text-sm text-zinc-400 px-1">
                                        <span>{generationStatus}</span>
                                        <span>{getProgress()}%</span>
                                    </div>
                                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                                        <motion.div
                                            className={`h-full bg-gradient-to-r ${accentStyles.progress}`}
                                            initial={{ width: '0%' }}
                                            animate={{ width: `${getProgress()}%` }}
                                            transition={{ duration: 0.5 }}
                                        />
                                    </div>
                                    <p className="text-xs text-zinc-600 text-center">Usually takes 30–90 seconds.</p>
                                </div>
                            )}

                            {/* Error */}
                            {error && (
                                <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                                    <p className="text-sm text-red-400 text-center">{error}</p>
                                </div>
                            )}
                        </motion.div>
                    </div>
                </div>

                {/* Output Image */}
                {outputImage && (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="mt-12 flex flex-col items-center gap-6"
                    >
                        <h2 className="text-xl font-bold text-green-400">🎉 Your Image is Ready!</h2>
                        <div className="w-full max-w-2xl rounded-2xl overflow-hidden border border-zinc-800">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={outputImage} alt="Generated image" className="w-full h-auto block" />
                        </div>
                        <a
                            href={outputImage}
                            download="generated-image.jpg"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 rounded-full font-medium transition-colors"
                        >
                            <Download className="w-5 h-5" />
                            Download Image
                        </a>
                    </motion.div>
                )}
            </div>

            {/* Remix Preview Modal */}
            <AnimatePresence>
                {isPreviewModalOpen && remixImageUrl && (
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
                            onClick={(e) => e.stopPropagation()}
                            className="bg-zinc-900 border border-white/10 p-6 rounded-3xl max-w-2xl w-full flex flex-col gap-6 shadow-2xl relative"
                        >
                            <button
                                onClick={() => setIsPreviewModalOpen(false)}
                                className="absolute top-4 right-4 p-2 bg-black/50 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                            
                            <h2 className="text-xl font-bold bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">
                                Original Creation
                            </h2>
                            
                            <div className="rounded-xl overflow-hidden border border-white/5 bg-black/50 flex items-center justify-center flex-1 min-h-[300px]">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={remixImageUrl} alt="Original" className="max-h-[60vh] object-contain rounded-xl" />
                            </div>
                            
                            <div className="bg-black/40 p-4 rounded-2xl border border-white/5 flex flex-col gap-2">
                                <div className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Prompt</div>
                                <p className="text-sm text-zinc-300 leading-relaxed max-h-32 overflow-y-auto pr-2 custom-scrollbar">
                                    {prompt || "No prompt available"}
                                </p>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
