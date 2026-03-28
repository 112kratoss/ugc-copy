'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, X } from 'lucide-react';

import CreatorIdentity from '@/app/components/CreatorIdentity';
import type { ShowcaseCreator } from '@/lib/showcase';

export type MediaDetailsType = 'image' | 'video' | 'audio';

interface MediaDetailsPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  mediaType: MediaDetailsType;
  src: string | null;
  alt: string;
  title: string;
  prompt?: string | null;
  creator?: ShowcaseCreator;
  actions?: ReactNode;
}

export default function MediaDetailsPreviewModal({
  isOpen,
  onClose,
  mediaType,
  src,
  alt,
  title,
  prompt,
  creator,
  actions,
}: MediaDetailsPreviewModalProps) {
  return (
    <AnimatePresence>
      {isOpen && src ? (
        <MediaDetailsPreviewDialog
          key={`${mediaType}:${src}`}
          onClose={onClose}
          mediaType={mediaType}
          src={src}
          alt={alt}
          title={title}
          prompt={prompt}
          creator={creator}
          actions={actions}
        />
      ) : null}
    </AnimatePresence>
  );
}

function MediaDetailsPreviewDialog({
  onClose,
  mediaType,
  src,
  alt,
  title,
  prompt,
  creator,
  actions,
}: Omit<MediaDetailsPreviewModalProps, 'isOpen'>) {
  const titleId = useId();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trimmedPrompt = prompt?.trim() ?? '';
  const hasPrompt = trimmedPrompt.length > 0;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const queueCopyStateReset = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }

    resetTimerRef.current = setTimeout(() => {
      setCopyState('idle');
    }, 2000);
  };

  const handleCopyPrompt = async () => {
    if (!hasPrompt || !navigator.clipboard?.writeText) {
      setCopyState('error');
      queueCopyStateReset();
      return;
    }

    try {
      await navigator.clipboard.writeText(trimmedPrompt);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }

    queueCopyStateReset();
  };

  const renderMedia = () => {
    if (!src) {
      return null;
    }

    if (mediaType === 'image') {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="max-h-[68vh] w-full object-contain" />
      );
    }

    if (mediaType === 'audio') {
      return (
        <div className="flex w-full max-w-xl flex-col gap-5 rounded-[24px] border border-white/5 bg-zinc-950/80 p-6">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Audio preview</div>
            <p className="mt-2 text-sm text-zinc-400">Listen to the saved generation and copy the prompt below if you want to reuse it.</p>
          </div>
          <audio src={src} controls autoPlay className="w-full" />
        </div>
      );
    }

    return (
      <video
        src={src}
        controls
        autoPlay
        loop
        playsInline
        preload="metadata"
        className="max-h-[68vh] w-full object-contain"
      />
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 20 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col gap-6 rounded-[30px] border border-white/10 bg-zinc-900 p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="pr-12">
          <h2 id={titleId} className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-xl font-bold tracking-tight text-transparent">
            {title}
          </h2>
          {creator ? (
            <div className="mt-4">
              <CreatorIdentity creator={creator} />
            </div>
          ) : null}
          {actions ? (
            <div className="mt-4 flex flex-wrap gap-3">
              {actions}
            </div>
          ) : null}
        </div>

        <div className="flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-[24px] border border-white/5 bg-black/50">
          {renderMedia()}
        </div>

        <div className="rounded-[22px] border border-white/5 bg-black/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Prompt</div>
            {hasPrompt ? (
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                aria-live="polite"
              >
                {copyState === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Try again' : 'Copy prompt'}
              </button>
            ) : null}
          </div>
          <p className="mt-3 max-h-40 overflow-y-auto pr-2 text-sm leading-relaxed text-zinc-300 custom-scrollbar">
            {hasPrompt ? trimmedPrompt : 'No prompt available'}
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}
