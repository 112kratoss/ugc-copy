'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Sparkles, Loader2, Download, X, Image as ImageIcon, Video, Plus, Trash2, Volume2, VolumeX } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';

const MODES = [
    { value: 'std', label: 'Standard (720p)' },
    { value: 'pro', label: 'Pro (1080p, High Quality)' }
];
const ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
const SINGLE_SHOT_DURATIONS = [5, 10];

interface MultiShot {
    id: string;
    prompt: string;
    duration: number;
}

export default function CreateVideoPage() {
    const router = useRouter();
    const [isLoadingUser, setIsLoadingUser] = useState(true);
    const [userCredits, setUserCredits] = useState<number | null>(null);

    // Form State
    const [isMultiShot, setIsMultiShot] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [singleDuration, setSingleDuration] = useState(5);
    const [multiPrompts, setMultiPrompts] = useState<MultiShot[]>([
        { id: '1', prompt: '', duration: 5 }
    ]);
    const [startImageFile, setStartImageFile] = useState<File | null>(null);
    const [startImageUrl, setStartImageUrl] = useState<string | null>(null);
    const [endImageFile, setEndImageFile] = useState<File | null>(null);
    const [endImageUrl, setEndImageUrl] = useState<string | null>(null);
    const [mode, setMode] = useState('std');
    const [aspectRatio, setAspectRatio] = useState('16:9');
    const [sound, setSound] = useState(false);

    // UI/Generation State
    const [isDraggingStart, setIsDraggingStart] = useState(false);
    const [isDraggingEnd, setIsDraggingEnd] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

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

    // Derived Cost mapping based on mode, sound, and total duration (Kling 3.0 specs)
    let creditsPerSecond = 20; // std, no audio
    if (mode === 'std' && sound) creditsPerSecond = 30;
    if (mode === 'pro' && !sound) creditsPerSecond = 27;
    if (mode === 'pro' && sound) creditsPerSecond = 40;
    
    const totalDuration = isMultiShot ? multiPrompts.reduce((acc, curr) => acc + curr.duration, 0) : singleDuration;
    const estimatedCost = Math.ceil(totalDuration * creditsPerSecond);
    const insufficientCredits = userCredits !== null && userCredits < estimatedCost;

    // Multi-shot handlers
    const addShot = () => {
        setMultiPrompts([...multiPrompts, { id: Math.random().toString(), prompt: '', duration: 5 }]);
    };
    const removeShot = (id: string) => {
        if (multiPrompts.length > 1) {
            setMultiPrompts(multiPrompts.filter(p => p.id !== id));
        }
    };
    const updateShot = (id: string, field: 'prompt' | 'duration', value: string | number) => {
        setMultiPrompts(multiPrompts.map(p => p.id === id ? { ...p, [field]: value } : p));
    };

    // Image handlers
    const handleImageDrop = (e: React.DragEvent, type: 'start' | 'end') => {
        e.preventDefault();
        if (type === 'start') { setIsDraggingStart(false); } else { setIsDraggingEnd(false); }
        const file = e.dataTransfer.files?.[0];
        if (file && file.type.startsWith('image/')) {
            if (type === 'start') { setStartImageFile(file); setStartImageUrl(URL.createObjectURL(file)); }
            else { setEndImageFile(file); setEndImageUrl(URL.createObjectURL(file)); }
        }
    };
    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'start' | 'end') => {
        const file = e.target.files?.[0];
        if (file && file.type.startsWith('image/')) {
            if (type === 'start') { setStartImageFile(file); setStartImageUrl(URL.createObjectURL(file)); }
            else { setEndImageFile(file); setEndImageUrl(URL.createObjectURL(file)); }
            e.target.value = '';
        }
    };
    const clearImage = (e: React.MouseEvent, type: 'start' | 'end') => {
        e.preventDefault();
        if (type === 'start') { setStartImageFile(null); setStartImageUrl(null); }
        else { setEndImageFile(null); setEndImageUrl(null); }
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
        const maxAttempts = 120; // 10 mins
        let attempts = 0;
        const startTime = Date.now();

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate-video?id=${predictionId}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
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
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }
        throw new Error('Video generation timed out.');
    };

    const handleGenerate = async () => {
        if (isMultiShot) {
            if (multiPrompts.some(p => !p.prompt.trim())) { setError('All shots must have a prompt'); return; }
        } else {
            if (!prompt.trim()) { setError('Please enter a prompt'); return; }
        }
        if (insufficientCredits) {
            setError(`Insufficient credits. This costs ${estimatedCost} credits.`); return;
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
            if (!session) { router.push('/login?returnUrl=/create-video'); return; }

            const payload = {
                isMultiShot,
                prompt: prompt.trim(),
                multiPrompts: multiPrompts,
                duration: singleDuration,
                startImageUrl: startUrl,
                endImageUrl: endUrl,
                mode,
                aspectRatio,
                sound
            };

            const response = await fetch('/api/generate-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Failed to start generation');

            const outputUrl = await pollPrediction(data.predictionId, session.access_token);
            setOutputVideo(outputUrl);
            setGenerationStatus('Video generated successfully! (100%)');
            if (data.remainingCredits !== undefined) setUserCredits(data.remainingCredits);

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
                {/* Header */}
                <div className="flex items-center gap-4 mb-8">
                    <Link href="/create" className="group p-3 rounded-full bg-zinc-900/50 border border-white/5 hover:bg-zinc-800 hover:border-white/10 transition-all backdrop-blur-md">
                        <ArrowLeft className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 text-transparent bg-clip-text">Advanced Video</h1>
                        <p className="text-sm text-zinc-500 font-medium tracking-wide">KLING 3.0 CINEMATIC ENGINE</p>
                    </div>
                    {userCredits !== null && (
                        <div className="ml-auto flex items-center gap-2 px-4 py-2 bg-zinc-900/50 border border-white/5 rounded-full backdrop-blur-md">
                            <Sparkles className="w-4 h-4 text-purple-400" />
                            <span className="text-sm font-semibold text-white">{userCredits}</span>
                            <span className="text-xs text-zinc-500 hidden sm:inline">credits</span>
                        </div>
                    )}
                </div>

                <div className="grid lg:grid-cols-12 gap-8">
                    {/* Main Controls (Left) */}
                    <div className="lg:col-span-8 flex flex-col gap-6">

                        {/* Mode Selector */}
                        <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-2 flex gap-2 backdrop-blur-sm self-start">
                            <button
                                onClick={() => setIsMultiShot(false)}
                                className={`px-6 py-2.5 rounded-2xl text-sm font-bold transition-all ${!isMultiShot ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-zinc-500 hover:text-white'}`}
                            >
                                Single Shot
                            </button>
                            <button
                                onClick={() => setIsMultiShot(true)}
                                className={`px-6 py-2.5 rounded-2xl text-sm font-bold transition-all ${isMultiShot ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'text-zinc-500 hover:text-white'}`}
                            >
                                Multi-Shot
                            </button>
                        </div>

                        {/* Prompt Area */}
                        <AnimatePresence mode="popLayout">
                            {!isMultiShot ? (
                                <motion.div
                                    key="single-shot"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ duration: 0.2 }}
                                    className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm"
                                >
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Video Prompt</h2>
                                    <textarea
                                        value={prompt}
                                        onChange={(e) => setPrompt(e.target.value)}
                                        placeholder="Describe your scene in rich, cinematic detail..."
                                        maxLength={2500}
                                        className="w-full bg-black/50 text-white rounded-2xl p-5 border border-white/10 focus:border-blue-500/50 focus:ring-4 focus:ring-blue-500/10 outline-none resize-y min-h-[140px] text-sm leading-relaxed"
                                    />
                                    <div className="mt-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <span className="text-xs text-zinc-500 font-medium">Duration:</span>
                                            {SINGLE_SHOT_DURATIONS.map(dur => (
                                                <button
                                                    key={dur}
                                                    onClick={() => setSingleDuration(dur)}
                                                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${singleDuration === dur ? 'bg-white/10 text-white border border-white/20' : 'bg-black text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                                >{dur} sec</button>
                                            ))}
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
                                                <textarea
                                                    value={shot.prompt}
                                                    onChange={(e) => updateShot(shot.id, 'prompt', e.target.value)}
                                                    placeholder={`Describe shot ${index + 1}...`}
                                                    className="w-full bg-black/50 text-white rounded-2xl p-4 border border-white/10 focus:border-purple-500/50 outline-none resize-none min-h-[100px] text-sm mb-4"
                                                />
                                                <div className="flex items-center gap-3">
                                                    <span className="text-xs text-zinc-500 font-medium">Duration (1-12s):</span>
                                                    <input
                                                        type="range" min="1" max="12" step="1"
                                                        value={shot.duration}
                                                        onChange={(e) => updateShot(shot.id, 'duration', parseInt(e.target.value))}
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

                        {/* Images */}
                        <div className="grid sm:grid-cols-2 gap-4">
                            <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm">
                                <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                                    Start Frame <span className="text-[10px] text-zinc-600 normal-case">optional</span>
                                </h2>
                                <label
                                    className={`group flex flex-col items-center justify-center w-full h-[140px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDraggingStart ? 'border-cyan-400 bg-cyan-500/10' : 'border-zinc-700/50 hover:border-cyan-500/50'}`}
                                    onDragOver={(e) => { e.preventDefault(); setIsDraggingStart(true); }}
                                    onDragLeave={(e) => { e.preventDefault(); setIsDraggingStart(false); }}
                                    onDrop={(e) => handleImageDrop(e, 'start')}
                                >
                                    {startImageUrl ? (
                                        <div className="w-full h-full relative">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={startImageUrl} alt="Start frame" className="w-full h-full object-cover" />
                                            <button onClick={(e) => clearImage(e, 'start')} className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-red-500 text-white rounded-full"><X className="w-3 h-3" /></button>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center gap-2 text-zinc-500"><ImageIcon className="w-6 h-6" /><span className="text-xs">Upload Start Image</span></div>
                                    )}
                                    <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'start')} className="hidden" />
                                </label>
                            </div>

                            {!isMultiShot && (
                                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-zinc-900/30 border border-white/5 rounded-3xl p-5 backdrop-blur-sm">
                                    <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 flex items-center justify-between">
                                        End Frame <span className="text-[10px] text-zinc-600 normal-case">optional</span>
                                    </h2>
                                    <label
                                        className={`group flex flex-col items-center justify-center w-full h-[140px] border-2 border-dashed rounded-2xl cursor-pointer transition-all bg-black/40 overflow-hidden relative ${isDraggingEnd ? 'border-cyan-400 bg-cyan-500/10' : 'border-zinc-700/50 hover:border-cyan-500/50'}`}
                                        onDragOver={(e) => { e.preventDefault(); setIsDraggingEnd(true); }}
                                        onDragLeave={(e) => { e.preventDefault(); setIsDraggingEnd(false); }}
                                        onDrop={(e) => handleImageDrop(e, 'end')}
                                    >
                                        {endImageUrl ? (
                                            <div className="w-full h-full relative">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={endImageUrl} alt="End frame" className="w-full h-full object-cover" />
                                                <button onClick={(e) => clearImage(e, 'end')} className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-red-500 text-white rounded-full"><X className="w-3 h-3" /></button>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center gap-2 text-zinc-500"><ImageIcon className="w-6 h-6" /><span className="text-xs">Upload End Image</span></div>
                                        )}
                                        <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'end')} className="hidden" />
                                    </label>
                                </motion.div>
                            )}
                        </div>
                    </div>

                    {/* Sidebar / Configuration (Right) */}
                    <div className="lg:col-span-4 flex flex-col gap-6">

                        <div className="bg-zinc-900/30 border border-white/5 rounded-3xl p-6 backdrop-blur-sm space-y-6">

                            {/* Quality Mode */}
                            <div>
                                <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Model Quality</h2>
                                <div className="flex flex-col gap-2">
                                    {MODES.map(m => (
                                        <button
                                            key={m.value} onClick={() => setMode(m.value)}
                                            className={`p-3 rounded-xl text-sm font-medium transition-all text-left ${mode === m.value ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                        >
                                            {m.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Aspect Ratio */}
                            <div>
                                <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Aspect Ratio</h2>
                                <div className="flex gap-2">
                                    {ASPECT_RATIOS.map(ratio => (
                                        <button
                                            key={ratio} onClick={() => setAspectRatio(ratio)}
                                            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${aspectRatio === ratio ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'bg-black/50 text-zinc-500 border border-white/5 hover:bg-zinc-800'}`}
                                        >{ratio}</button>
                                    ))}
                                </div>
                            </div>

                            {/* Sound Effects */}
                            <div>
                                <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">Audio</h2>
                                <button
                                    onClick={() => setSound(!sound)}
                                    className={`w-full p-3 rounded-xl flex items-center justify-between text-sm font-medium transition-all ${sound ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-black/50 text-zinc-500 border border-white/5'}`}
                                >
                                    <span className="flex items-center gap-2">
                                        {sound ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                                        AI Sound Effects
                                    </span>
                                    <span>{sound ? 'ON' : 'OFF'}</span>
                                </button>
                            </div>

                        </div>

                        {/* Cost & Generate Button */}
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
                                    {isGenerating ? <><Loader2 className="w-5 h-5 animate-spin" /> Generating...</> : <><Video className="w-5 h-5" /> Generate Masterpiece</>}
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
                                            initial={{ width: '0%' }} animate={{ width: `${getProgress()}%` }} transition={{ duration: 0.5 }}
                                        />
                                    </div>
                                </div>
                            )}
                            {error && <p className="mt-4 text-xs text-red-400 text-center bg-red-400/10 py-2 rounded-lg">{error}</p>}
                        </div>

                    </div>
                </div>

                {/* Video Output */}
                {outputVideo && (
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mt-12 bg-zinc-900/30 border border-green-500/20 rounded-3xl p-6 backdrop-blur-sm flex flex-col items-center">
                        <h2 className="text-xl font-bold text-green-400 mb-6 flex items-center gap-2">
                            <Sparkles className="w-5 h-5" /> Your Video is Ready!
                        </h2>
                        <div className="w-full max-w-3xl rounded-2xl overflow-hidden bg-black aspect-video flex items-center justify-center border border-white/10 shadow-2xl">
                            <video src={outputVideo} controls autoPlay loop className="w-full h-full object-contain" />
                        </div>
                        <a href={outputVideo} download="kling_generation.mp4" target="_blank" rel="noopener noreferrer" className="mt-6 px-8 py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-full flex items-center gap-2 transition-all">
                            <Download className="w-4 h-4" /> Download Video
                        </a>
                    </motion.div>
                )}

            </div>
        </div>
    );
}
