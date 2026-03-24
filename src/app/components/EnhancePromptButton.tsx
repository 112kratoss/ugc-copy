'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Loader2, AlertCircle } from 'lucide-react';
import type { EnhancerContext } from '@/lib/prompt-enhancer';
import { supabase } from '@/lib/supabase';

interface EnhancePromptButtonProps {
    prompt: string;
    onEnhanced: (enhancedPrompt: string) => void;
    onCreditsUpdate: (remainingCredits: number) => void;
    medium: 'image' | 'video' | 'motion';
    selectedModel: string;
    context?: EnhancerContext;
    disabled?: boolean;
}

export default function EnhancePromptButton({
    prompt,
    onEnhanced,
    onCreditsUpdate,
    medium,
    selectedModel,
    context,
    disabled = false,
}: EnhancePromptButtonProps) {
    const [isEnhancing, setIsEnhancing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canEnhance = prompt.trim().length > 0 && !isEnhancing && !disabled;

    const handleEnhance = async () => {
        if (!canEnhance) return;

        setIsEnhancing(true);
        setError(null);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                setError('Please log in to enhance prompts');
                return;
            }

            const response = await fetch('/api/enhance-prompt', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ medium, selectedModel, prompt, context }),
            });

            const data = await response.json();

            if (!response.ok) {
                if (response.status === 402) {
                    setError('Not enough credits (2 required)');
                } else {
                    setError(data.error || 'Enhancement failed');
                }
                // Update credits even on failure (may have been refunded)
                if (data.remainingCredits !== undefined) {
                    onCreditsUpdate(data.remainingCredits);
                }
                return;
            }

            onEnhanced(data.enhancedPrompt);
            if (data.remainingCredits !== undefined) {
                onCreditsUpdate(data.remainingCredits);
            }
        } catch (err) {
            console.error('Enhance prompt error:', err);
            setError('Something went wrong. Please try again.');
        } finally {
            setIsEnhancing(false);
        }
    };

    useEffect(() => {
        if (!error) return;

        const timeoutId = window.setTimeout(() => setError(null), 5000);
        return () => window.clearTimeout(timeoutId);
    }, [error]);

    return (
        <div className="flex flex-col gap-1.5 mb-2">
            <div className="flex items-center gap-2">
                <button
                    onClick={handleEnhance}
                    disabled={!canEnhance}
                    className={`group flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all duration-300 ${
                        canEnhance
                            ? 'bg-gradient-to-r from-violet-600/20 to-blue-600/20 text-violet-300 border border-violet-500/30 hover:from-violet-600/30 hover:to-blue-600/30 hover:border-violet-500/50 hover:shadow-[0_0_20px_-5px_rgba(139,92,246,0.3)] active:scale-[0.97]'
                            : 'bg-zinc-900/30 text-zinc-600 border border-white/5 cursor-not-allowed'
                    }`}
                >
                    {isEnhancing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                        <Sparkles className={`w-3.5 h-3.5 transition-all ${canEnhance ? 'group-hover:scale-110' : ''}`} />
                    )}
                    <span>{isEnhancing ? 'Enhancing...' : 'Enhance'}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        canEnhance
                            ? 'bg-violet-500/20 text-violet-400'
                            : 'bg-zinc-800 text-zinc-600'
                    }`}>
                        2 credits
                    </span>
                </button>
            </div>

            {error && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg animate-in fade-in slide-in-from-top-1 duration-200">
                    <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
                    <span className="text-xs text-red-400">{error}</span>
                </div>
            )}
        </div>
    );
}
