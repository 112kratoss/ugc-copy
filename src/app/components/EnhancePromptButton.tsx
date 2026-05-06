'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Loader2, AlertCircle } from 'lucide-react';
import type { EnhancerContext } from '@/lib/prompt-enhancer';
import {
    PromptEnhancementError,
    type PromptEnhancementResult,
    requestPromptEnhancement,
} from '@/app/components/enhancePromptClient';

interface EnhancePromptButtonProps {
    prompt: string;
    onEnhanced: (enhancedPrompt: string, result?: PromptEnhancementResult) => void;
    onCreditsUpdate: (remainingCredits: number) => void;
    onResult?: (result: PromptEnhancementResult) => void;
    medium: 'image' | 'video' | 'motion';
    selectedModel: string;
    context?: EnhancerContext;
    disabled?: boolean;
    label?: string;
    helperText?: string;
    showWarnings?: boolean;
}

export default function EnhancePromptButton({
    prompt,
    onEnhanced,
    onCreditsUpdate,
    onResult,
    medium,
    selectedModel,
    context,
    disabled = false,
    label = 'Enhance',
    helperText,
    showWarnings = true,
}: EnhancePromptButtonProps) {
    const [isEnhancing, setIsEnhancing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<PromptEnhancementResult['warnings']>(undefined);
    const loadingLabel = label === 'Polish' ? 'Polishing...' : 'Enhancing...';

    const canEnhance = prompt.trim().length > 0 && !isEnhancing && !disabled;

    const handleEnhance = async () => {
        if (!canEnhance) return;

        setIsEnhancing(true);
        setError(null);
        setWarnings(undefined);

        try {
            const result = await requestPromptEnhancement({
                medium,
                selectedModel,
                prompt,
                context,
            });

            onEnhanced(result.enhancedPrompt, result);
            onResult?.(result);
            setWarnings(result.warnings?.filter((warning) => warning.severity !== 'blocking'));
            if (result.remainingCredits !== undefined) {
                onCreditsUpdate(result.remainingCredits);
            }
        } catch (err) {
            console.error('Enhance prompt error:', err);
            if (err instanceof PromptEnhancementError) {
                if (err.remainingCredits !== undefined) {
                    onCreditsUpdate(err.remainingCredits);
                }
                setError(err.message);
            } else {
                setError('Something went wrong. Please try again.');
            }
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
                    <span>{isEnhancing ? loadingLabel : label}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                        canEnhance
                            ? 'bg-violet-500/20 text-violet-400'
                            : 'bg-zinc-800 text-zinc-600'
                    }`}>
                        2 credits
                    </span>
                </button>
            </div>

            {!error && helperText && (
                <p className="px-1 text-xs text-zinc-500">{helperText}</p>
            )}

            {showWarnings && !error && warnings && warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    <p className="font-semibold">Prompt quality notes</p>
                    <ul className="mt-1 space-y-1">
                        {warnings.slice(0, 3).map((warning) => (
                            <li key={warning.code}>{warning.message}</li>
                        ))}
                    </ul>
                </div>
            )}

            {error && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg animate-in fade-in slide-in-from-top-1 duration-200">
                    <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
                    <span className="text-xs text-red-400">{error}</span>
                </div>
            )}
        </div>
    );
}
