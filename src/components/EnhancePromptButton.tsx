'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Sparkles, Loader2, AlertCircle, Undo2 } from 'lucide-react';
import { PROMPT_ENHANCEMENT_COST_CREDITS } from '../../ugc-mobile/lib/model-catalog/protocol';
import type { EnhancerContext, Medium, PromptEnhancementLevel } from '@/lib/prompt-enhancer';
import {
    PromptEnhancementError,
    type PromptEnhancementResult,
    requestPromptEnhancement,
} from '@/components/enhancePromptClient';

// The service debits this same constant, so the price on the button is the charge.
const ENHANCEMENT_PRICE_LABEL = `${PROMPT_ENHANCEMENT_COST_CREDITS} ${PROMPT_ENHANCEMENT_COST_CREDITS === 1 ? 'credit' : 'credits'}`;

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
    /**
     * `toolbar` draws Enhance as a tile, as the app's composer does, with the level
     * and Undo on a row under it; `inline` (the default) keeps them all on one line.
     */
    variant?: 'inline' | 'toolbar';
    /** A tile drawn before Enhance in the toolbar's row: the creators' Templates. */
    leading?: ReactNode;
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
    variant = 'inline',
    leading,
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

    const isToolbar = variant === 'toolbar';
    // The price as a phrase of its own: the two spans can run together ("Enhance2 credits").
    const enhanceLabel = `${isEnhancing ? loadingLabel : label}, ${ENHANCEMENT_PRICE_LABEL}`;

    const levelToggle = showLevelToggle ? (
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
                    className={`rounded-md font-semibold transition-colors ${isToolbar ? 'min-h-8 px-3 text-xs' : 'px-2 py-0.5 text-[10px]'} ${
                        level === value
                            ? 'bg-[#ff7a59]/20 text-[#ffb09c]'
                            : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                    {levelLabel}
                </button>
            ))}
        </div>
    ) : null;

    const undoButton = canUndo ? (
        <button
            type="button"
            onClick={handleUndo}
            className={`flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-900/40 font-medium text-zinc-400 transition-colors hover:border-white/20 hover:text-zinc-200 ${isToolbar ? 'min-h-9 px-3 text-xs' : 'px-2 py-1 text-[11px]'}`}
        >
            <Undo2 className="w-3 h-3" />
            <span>Undo</span>
        </button>
    ) : null;

    const notes = (
        <>
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
        </>
    );

    if (isToolbar) {
        return (
            <div className="flex flex-col gap-2">
                <div className={`grid gap-2 ${leading ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {leading}
                    <button
                        type="button"
                        onClick={handleEnhance}
                        disabled={!canEnhance}
                        aria-label={enhanceLabel}
                        className={`ui-focus-ring flex min-h-12 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-2xl border px-3 py-1.5 text-sm font-semibold transition-[background-color,border-color,transform] duration-150 ${
                            canEnhance
                                ? 'border-[#ff7a59]/35 bg-[#ff7a59]/10 text-[#ffb09c] hover:border-[#ff7a59]/55 hover:bg-[#ff7a59]/15 active:scale-[0.98]'
                                : 'cursor-not-allowed border-white/5 bg-zinc-900/40 text-zinc-500'
                        }`}
                    >
                        <span className="flex items-center gap-2">
                            {isEnhancing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                            {isEnhancing ? loadingLabel : label}
                        </span>
                        {/* The price keeps to one line: where the tile is too narrow for both it takes the next. */}
                        {isEnhancing ? null : (
                            <span className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] ${canEnhance ? 'bg-black/25 text-[#ffc1b2]' : 'bg-zinc-800 text-zinc-600'}`}>
                                {ENHANCEMENT_PRICE_LABEL}
                            </span>
                        )}
                    </button>
                </div>
                {levelToggle || undoButton ? (
                    <div className="flex items-center gap-2">
                        {levelToggle}
                        {undoButton}
                    </div>
                ) : null}
                {notes}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-1.5 mb-2">
            <div className="flex items-center gap-2">
                <button
                    onClick={handleEnhance}
                    disabled={!canEnhance}
                    aria-label={enhanceLabel}
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
                        {ENHANCEMENT_PRICE_LABEL}
                    </span>
                </button>

                {levelToggle}

                {undoButton}
            </div>

            {notes}
        </div>
    );
}
