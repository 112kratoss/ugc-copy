'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Upload, Sparkles, Loader2, Download, Play } from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabase';

export default function CreatePage() {
    const [characterImage, setCharacterImage] = useState<string | null>(null);
    const [characterImageFile, setCharacterImageFile] = useState<File | null>(null);
    const [referenceVideo, setReferenceVideo] = useState<string | null>(null);
    const [referenceVideoFile, setReferenceVideoFile] = useState<File | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<string | null>(null);
    const [outputVideo, setOutputVideo] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

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

            // Call our API to start the generation
            const response = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    characterImageUrl: imageUrl,
                    referenceVideoUrl: videoUrl
                })
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to start generation');
            }

            setGenerationStatus('Kling AI is animating your video... (this may take 5-8 minutes for 30s)');

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
                    <h1 className="text-2xl font-bold">Create New Video (Kling AI 30s)</h1>
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

                        <label className="flex flex-col items-center justify-center w-full h-64 border-2 border-dashed border-zinc-800 rounded-2xl cursor-pointer hover:border-purple-500/50 transition-colors bg-zinc-900/50 overflow-hidden">
                            {characterImage ? (
                                <img
                                    src={characterImage}
                                    alt="Character"
                                    className="w-full h-full object-cover"
                                />
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
                        <h2 className="text-lg font-medium text-zinc-300">2. Upload Motion Reference</h2>
                        <p className="text-sm text-zinc-500">Video with the actions you want</p>

                        <label className="flex flex-col items-center justify-center w-full h-64 border-2 border-dashed border-zinc-800 rounded-2xl cursor-pointer hover:border-purple-500/50 transition-colors bg-zinc-900/50 overflow-hidden">
                            {referenceVideo ? (
                                <video
                                    src={referenceVideo}
                                    className="w-full h-full object-cover"
                                    autoPlay
                                    loop
                                    muted
                                />
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

                {/* Generate Button */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="mt-12 flex flex-col items-center gap-4"
                >
                    <button
                        onClick={handleGenerate}
                        disabled={!characterImage || !referenceVideo || isGenerating}
                        className="flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-600 rounded-full font-medium text-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isGenerating ? (
                            <>
                                <Loader2 className="w-5 h-5 animate-spin" />
                                Generating...
                            </>
                        ) : (
                            <>
                                <Sparkles className="w-5 h-5" />
                                Generate Video
                            </>
                        )}
                    </button>

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
        </div>
    );
}
