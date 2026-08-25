'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Loader2, AlertCircle, Undo2 } from 'lucide-react';
import type { EnhancerContext, Medium, PromptEnhancementLevel } from '@/lib/prompt-enhancer';
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
    medium: Medium;
    selectedModel: string;
    context?: EnhancerContext;
    /**
     * Optional async context builder that runs right before the request — used
     * to upload attached frames so the enhancer can see them. Falls back to
     * `context` when it resolves to undefined or throws.
     */
    prepareContext?: () => Promise<EnhancerContext | undefined>;
    disabled?: boolean;
    label?: string;
    helperText?: string;
    showWarnings?: boolean;
    /** Hide the Full/Light level toggle (e.g. append-only element mode). */
    showLevelToggle?: boolean;
}

export default function EnhancePromptButton({
    prompt,
    onEnhanced,
    onCreditsUpdate,
    onResult,
    medium,
    selectedModel,
    context,
    prepareContext,
    disabled = false,
    label = 'Enhance',
    helperText,
    showWarnings = true,
    showLevelToggle = true,
}: EnhancePromptButtonProps) {
    const [isEnhancing, setIsEnhancing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<PromptEnhancementResult['warnings']>(undefined);
    const [level, setLevel] = useState<PromptEnhancementLevel>('cinematic');
    const [undoState, setUndoState] = useState<{ previous: string; enhanced: string } | null>(null);
    const loadingLabel = label === 'Polish' ? 'Polishing...' : 'Enhancing...';

    const canEnhance = prompt.trim().length > 0 && !isEnhancing && !disabled;
    // The undo chip only makes sense while the textbox still holds the enhancement.
    const canUndo = undoState !== null && undoState.enhanced === prompt && !isEnhancing;

    const handleEnhance = async () => {
        if (!canEnhance) return;

        setIsEnhancing(true);
        setError(null);
        setWarnings(undefined);

        try {
            let requestContext = context;
            if (prepareContext) {
                try {
                    requestContext = (await prepareContext()) ?? context;
                } catch {
                    requestContext = context;
                }
            }

            const result = await requestPromptEnhancement({
                medium,
                selectedModel,
                prompt,
                context: { ...requestContext, enhancementLevel: level },
            });

            setUndoState({ previous: prompt, enhanced: result.enhancedPrompt });
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

    const handleUndo = () => {
        if (!canUndo || !undoState) return;
        onEnhanced(undoState.previous);
        setUndoState(null);
        setWarnings(undefined);
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
                            ? 'border border-[#ff7a59]/30 bg-[#ff7a59]/10 text-[#ffb09c] hover:border-[#ff7a59]/50 hover:bg-[#ff7a59]/15 active:scale-[0.97]'
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
                            ? 'bg-black/25 text-[#ffc1b2]'
                            : 'bg-zinc-800 text-zinc-600'
                    }`}>
                        2 credits
                    </span>
                </button>

                {showLevelToggle && (
                    <div className="flex items-center rounded-lg border border-white/10 bg-zinc-900/40 p-0.5" role="group" aria-label="Enhancement level">
                        {([['cinematic', 'Full'], ['faithful', 'Light']] as const).map(([value, levelLabel]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setLevel(value)}
                                aria-pressed={level === value}
                                title={value === 'cinematic'
                                    ? 'Full rewrite with model-specific craft'
                                    : 'Light touch — keeps your wording, fills only missing essentials'}
                                className={`px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors ${
                                    level === value
                                        ? 'bg-[#ff7a59]/20 text-[#ffb09c]'
                                        : 'text-zinc-500 hover:text-zinc-300'
                                }`}
                            >
                                {levelLabel}
                            </button>
                        ))}
                    </div>
                )}

                {canUndo && (
                    <button
                        type="button"
                        onClick={handleUndo}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-zinc-400 border border-white/10 bg-zinc-900/40 hover:text-zinc-200 hover:border-white/20 transition-colors"
                    >
                        <Undo2 className="w-3 h-3" />
                        <span>Undo</span>
                    </button>
                )}
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
