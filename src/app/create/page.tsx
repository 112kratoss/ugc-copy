'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Upload, Sparkles, Loader2, Download, Play } from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabase';

export default function CreatePage() {
    const router = useRouter();
    const [isLoadingUser, setIsLoadingUser] = useState(true);
    const [characterImage, setCharacterImage] = useState<string | null>(null);
    const [characterImageFile, setCharacterImageFile] = useState<File | null>(null);
    const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
    const [referenceVideoFile, setReferenceVideoFile] = useState<File | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [credits, setCredits] = useState<number | null>(null);
    const [characterOrientation, setCharacterOrientation] = useState<'video' | 'image'>('video');
    const [mode, setMode] = useState<'720p' | '1080p'>('720p');
    const [duration, setDuration] = useState<number>(0);

    useEffect(() => {
        checkUser();
    }, []);

    const checkUser = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            router.push('/login');
        } else {
            setIsLoadingUser(false);
            fetchCredits(session.user.id);
        }
    };

    const fetchCredits = async (userId: string) => {
        const { data } = await supabase
            .from('profiles')
            .select('credits')
            .eq('id', userId)
            .single();
        if (data) setCredits(data.credits);
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setCharacterImageFile(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setCharacterImage(reader.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setReferenceVideoFile(file);
            const url = URL.createObjectURL(file);
            setReferenceVideo(url);
            // Duration will be set when metadata loads via onLoadedMetadata
        }
    };

    const handleVideoMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
        const vidDuration = e.currentTarget.duration;
        if (vidDuration) {
            setDuration(vidDuration);
            if (vidDuration > 30) {
                setError("Note: Video is longer than 30s. Only first 30s will be generated.");
            } else {
                setError(null);
            }
        }
    };

    const uploadToSupabase = async (file: File, folder: string) => {
        const filename = `${folder}/${Date.now()}-${file.name}`;
        const { data, error } = await supabase.storage
            .from('uploads')
            .upload(filename, file, { upsert: true });

        if (error) throw error;

        const { data: { publicUrl } } = supabase.storage
            .from('uploads')
            .getPublicUrl(filename);

        return publicUrl;
    };

    const pollPrediction = async (predictionId: string): Promise<string> => {
        const maxAttempts = 120; // 10 minutes max
        let attempts = 0;

        while (attempts < maxAttempts) {
            const response = await fetch(`/api/generate?id=${predictionId}`);
            const data = await response.json();

            if (data.status === 'succeeded') {
                return data.output;
            } else if (data.status === 'failed') {
                throw new Error(data.error || 'Generation failed');
            }

            setGenerationStatus(`Processing... (${Math.round(attempts * 5 / 60)} min elapsed)`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error('Generation timed out');
    };

    const handleGenerate = async () => {
        if (!characterImageFile || !referenceVideoFile) {
            alert('Please upload both a character image and a reference video');
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
            setGenerationStatus('Uploading files...');

            // Upload both files to Supabase
            const [imageUrl, videoUrl] = await Promise.all([
                uploadToSupabase(characterImageFile, 'images'),
                uploadToSupabase(referenceVideoFile, 'videos')
            ]);

            setGenerationStatus('Starting AI generation...');

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
                    mode
                })
            });

            const data = await response.json();

            if (!data.success) {
                const errorMessage = data.details
                    ? `${data.error}: ${data.details} (Code: ${data.code})`
                    : (data.error || 'Failed to start generation');
                throw new Error(errorMessage);
            }

            if (typeof data.remainingCredits === 'number') {
                setCredits(data.remainingCredits);
            }

            setGenerationStatus(`Kling AI is animating your video (${effectiveDuration}s)... (this may take 3-6 minutes)`);

            // Poll for completion
            const outputUrl = await pollPrediction(data.predictionId);
            setOutputVideo(outputUrl);
            setGenerationStatus('Video generated successfully!');

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

    return (
        <div className="min-h-screen bg-black text-white p-8">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <div className="flex items-center gap-4 mb-12">
                    <Link
                        href="/"
                        className="p-2 rounded-full bg-zinc-900 hover:bg-zinc-800 transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <h1 className="text-2xl font-bold">Create New Video (Kling AI)</h1>
                </div>
                {credits !== null && (
                    <div className="bg-zinc-900 px-4 py-2 rounded-full border border-zinc-800 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-yellow-500" />
                        <span className="font-medium">{credits} Credits</span>
                    </div>
                )}
            </div>

            <div className="grid md:grid-cols-2 gap-8">
                {/* Character Image Upload */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex flex-col gap-4"
                >
                    <h2 className="text-lg font-medium text-zinc-300">1. Upload Character Image</h2>
                    <p className="text-sm text-zinc-500">Full body photo works best (JPG recommended)</p>

                    <label className="flex flex-col items-center justify-center w-full h-64 border-2 border-dashed border-zinc-800 rounded-2xl cursor-pointer hover:border-purple-500/50 transition-colors bg-zinc-900/50 overflow-hidden relative">
                        {characterImage ? (
                            <div className="w-full h-full flex items-center justify-center bg-black/50">
                                <img
                                    src={characterImage}
                                    alt="Character"
                                    className="w-full h-full object-contain"
                                />
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-2 text-zinc-500">
                                <Upload className="w-8 h-8" />
                                <span className="text-sm">Click to upload image</span>
                            </div>
                        )}
                        <input
                            type="file"
                            accept="image/*"
                            onChange={handleImageUpload}
                            className="hidden"
                        />
                    </label>
                </motion.div>

                {/* Reference Video Upload */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="flex flex-col gap-4"
                >
                    <h2 className="text-lg font-medium text-zinc-300">2. Upload Reference Video</h2>
                    <p className="text-sm text-zinc-500">Video with the actions you want</p>

                    <label className="flex flex-col items-center justify-center w-full h-64 border-2 border-dashed border-zinc-800 rounded-2xl cursor-pointer hover:border-purple-500/50 transition-colors bg-zinc-900/50 overflow-hidden relative">
                        {referenceVideo ? (
                            <div className="w-full h-full flex items-center justify-center bg-black/50">
                                <video
                                    src={referenceVideo}
                                    className="w-full h-full object-contain"
                                    autoPlay
                                    loop
                                    muted
                                    onLoadedMetadata={handleVideoMetadata}
                                />
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-2 text-zinc-500">
                                <Upload className="w-8 h-8" />
                                <span className="text-sm">Click to upload video</span>
                            </div>
                        )}
                        <input
                            type="file"
                            accept="video/*"
                            onChange={handleVideoUpload}
                            className="hidden"
                        />
                    </label>
                </motion.div>
            </div>

            {/* Settings: Orientation and Mode */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
                className="mt-8 grid md:grid-cols-2 gap-8"
            >
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                    <h3 className="text-zinc-300 font-medium mb-3">Character Orientation</h3>
                    <div className="flex gap-4">
                        <button
                            onClick={() => setCharacterOrientation('video')}
                            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${characterOrientation === 'video'
                                ? 'bg-purple-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                }`}
                        >
                            Follow Video
                        </button>
                        <button
                            onClick={() => setCharacterOrientation('image')}
                            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${characterOrientation === 'image'
                                ? 'bg-purple-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                }`}
                        >
                            Follow Image
                        </button>
                    </div>
                    <p className="text-xs text-zinc-500 mt-2">
                        'Follow Video' matches the motion reference. 'Follow Image' keeps the original pose.
                    </p>
                </div>

                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                    <h3 className="text-zinc-300 font-medium mb-3">Quality Mode</h3>
                    <div className="flex gap-4">
                        <button
                            onClick={() => setMode('720p')}
                            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${mode === '720p'
                                ? 'bg-purple-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                }`}
                        >
                            Standard (720p)
                        </button>
                        <button
                            onClick={() => setMode('1080p')}
                            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors ${mode === '1080p'
                                ? 'bg-purple-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                }`}
                        >
                            Pro (1080p)
                        </button>
                    </div>
                    <p className="text-xs text-zinc-500 mt-2">
                        1080p may take longer to generate.
                    </p>
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
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 text-center w-full max-w-md">
                        <h3 className="text-zinc-400 mb-2">Estimated Cost</h3>
                        <div className="text-3xl font-bold text-white mb-1">
                            {Math.ceil(duration * (mode === '1080p' ? 9 : 6))} Credits
                        </div>
                        <p className="text-sm text-zinc-500">
                            Based on {duration.toFixed(1)}s video length ({mode === '1080p' ? '9' : '6'} credits/sec)
                        </p>
                    </div>
                ) : (
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 text-center w-full max-w-md">
                        <p className="text-zinc-500">Upload a video to see cost</p>
                    </div>
                )}
            </motion.div>

            {/* Generate Button */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="mt-8 flex flex-col items-center gap-4"
            >
                <button
                    onClick={handleGenerate}
                    disabled={!characterImage || !referenceVideo || isGenerating}
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
                {duration > 0 && (
                    <p className="text-xs text-zinc-500">
                        Cost: {Math.ceil(duration * (mode === '1080p' ? 9 : 6))} Credits
                    </p>
                )}

                {generationStatus && (
                    <p className="text-sm text-zinc-400">{generationStatus}</p>
                )}

                {error && (
                    <p className="text-sm text-red-400">{error}</p>
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
