'use client';

import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';

type StudioModelPickerAccent = 'blue' | 'rose' | 'violet';

const focusClasses: Record<StudioModelPickerAccent, string> = {
    blue: 'focus:border-blue-400/50 focus:ring-2 focus:ring-blue-400/10',
    rose: 'focus:border-[#ff7a59]/50 focus:ring-2 focus:ring-[#ff7a59]/10',
    violet: 'focus:border-violet-400/50 focus:ring-2 focus:ring-violet-400/10',
};

export default function StudioModelPicker({
    isOpen,
    query,
    onQueryChange,
    onDismiss,
    searchLabel,
    searchPlaceholder,
    resultListLabel,
    resultCount,
    accent,
    desktopInset = 'flush',
    children,
}: {
    isOpen: boolean;
    query: string;
    onQueryChange: (query: string) => void;
    onDismiss: () => void;
    searchLabel: string;
    searchPlaceholder: string;
    resultListLabel: string;
    resultCount: number;
    accent: StudioModelPickerAccent;
    desktopInset?: 'flush' | 'card';
    children: ReactNode;
}) {
    return (
        <AnimatePresence>
            {isOpen ? (
                <motion.div
                    initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
                    animate={{ opacity: 1, y: 0, scaleY: 1 }}
                    exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
                    transition={{ duration: 0.15 }}
                    className={clsx(
                        'fixed inset-x-4 bottom-4 z-50 flex max-h-[calc(100dvh-2rem)] w-auto flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/95 backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:mt-2 sm:max-h-[min(70vh,34rem)] sm:w-auto',
                        desktopInset === 'card' ? 'sm:left-6 sm:right-6' : 'sm:left-0 sm:right-0'
                    )}
                    style={{ transformOrigin: 'top' }}
                    data-testid="studio-model-picker"
                >
                    <div className="shrink-0 border-b border-white/8 p-3">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                            <input
                                autoFocus
                                type="search"
                                value={query}
                                onChange={(event) => onQueryChange(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Escape') onDismiss();
                                }}
                                placeholder={searchPlaceholder}
                                aria-label={searchLabel}
                                className={clsx(
                                    'h-11 w-full rounded-xl border border-white/10 bg-black/25 pl-10 pr-10 text-sm text-white outline-none transition placeholder:text-zinc-600',
                                    focusClasses[accent]
                                )}
                            />
                            {query ? (
                                <button
                                    type="button"
                                    onClick={() => onQueryChange('')}
                                    aria-label={`Clear ${searchLabel.toLowerCase()}`}
                                    className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/5 hover:text-white"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            ) : null}
                        </div>
                        <p className="mt-2 px-1 text-[11px] text-zinc-500" aria-live="polite">
                            {resultCount} {resultCount === 1 ? 'model' : 'models'}
                        </p>
                    </div>

                    <div
                        role="listbox"
                        aria-label={resultListLabel}
                        className="min-h-0 overflow-y-auto overscroll-contain app-scrollbar"
                    >
                        {resultCount > 0 ? children : (
                            <div className="px-5 py-10 text-center">
                                <Search className="mx-auto h-5 w-5 text-zinc-600" />
                                <p className="mt-3 text-sm font-medium text-zinc-300">No models found</p>
                                <p className="mt-1 text-xs text-zinc-500">Try a model name or capability.</p>
                            </div>
                        )}
                    </div>
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}
