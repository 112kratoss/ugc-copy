'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Film, Image as ImageIcon, Volume2, X } from 'lucide-react';
import { createPortal } from 'react-dom';

import CreatorIdentity from '@/app/components/CreatorIdentity';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import type { ShowcaseCreator } from '@/lib/showcase';

export type MediaDetailsType = 'image' | 'video' | 'audio' | 'text';

interface MediaDetailsPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  mediaType: MediaDetailsType;
  src: string | null;
  alt: string;
  title: string;
  prompt?: string | null;
  body?: string | null;
  inputMedia?: GenerationInputMediaItem[] | null;
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
  body,
  inputMedia,
  creator,
  actions,
}: MediaDetailsPreviewModalProps) {
  if (!isOpen || (!src && mediaType !== 'text')) {
    return null;
  }

  return (
    <MediaDetailsPreviewDialog
      key={`${mediaType}:${src ?? title}`}
      onClose={onClose}
      mediaType={mediaType}
      src={src}
      alt={alt}
      title={title}
      prompt={prompt}
      body={body}
      inputMedia={inputMedia}
      creator={creator}
      actions={actions}
    />
  );
}

function MediaDetailsPreviewDialog({
  onClose,
  mediaType,
  src,
  alt,
  title,
  prompt,
  body,
  inputMedia,
  creator,
  actions,
}: Omit<MediaDetailsPreviewModalProps, 'isOpen'>) {
  const titleId = useId();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const portalRoot = typeof document === 'undefined' ? null : document.body;
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trimmedPrompt = prompt?.trim() ?? '';
  const trimmedBody = body?.trim() ?? '';
  const hasPrompt = trimmedPrompt.length > 0;
  const hasBody = trimmedBody.length > 0;
  const visibleInputMedia = (inputMedia ?? []).filter((item) => Boolean(item.url));

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
      if (mediaType === 'text') {
        return (
          <div className="w-full max-w-2xl px-2 py-2">
            <div className="rounded-[24px] border border-white/8 bg-zinc-950/80 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.25)]">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Tip / Note</div>
              <div className="mt-4 whitespace-pre-wrap text-base leading-8 text-zinc-100">
                {hasBody ? trimmedBody : 'No note content available.'}
              </div>
            </div>
          </div>
        );
      }

      return null;
    }

    if (mediaType === 'image') {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="preview-modal-visual max-h-[45dvh] w-full object-contain sm:max-h-[68vh]" />
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
        className="preview-modal-visual max-h-[45dvh] w-full object-contain sm:max-h-[68vh]"
      />
    );
  };

  const getInputMediaIcon = (item: GenerationInputMediaItem) => {
    if (item.mediaType === 'video') return <Film className="h-3.5 w-3.5" />;
    if (item.mediaType === 'audio') return <Volume2 className="h-3.5 w-3.5" />;
    return <ImageIcon className="h-3.5 w-3.5" />;
  };

  const renderInputMediaPreview = (item: GenerationInputMediaItem) => {
    if (!item.url) return null;

    if (item.mediaType === 'image') {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.url} alt={item.label} className="h-24 w-full rounded-2xl object-cover" />
      );
    }

    if (item.mediaType === 'audio') {
      return (
        <div className="flex h-24 items-center rounded-2xl border border-white/8 bg-zinc-950/80 p-3">
          <audio src={item.url} controls className="w-full" />
        </div>
      );
    }

    return (
      <video
        src={item.url}
        controls
        playsInline
        preload="metadata"
        className="h-24 w-full rounded-2xl object-cover"
      />
    );
  };

  if (!portalRoot) {
    return null;
  }

  return createPortal(
    <div
      className="preview-modal-overlay fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className="preview-modal-panel relative flex max-h-[calc(100dvh-1.5rem)] min-w-0 w-full max-w-3xl flex-col gap-4 overflow-y-auto overscroll-contain rounded-[28px] border border-white/10 bg-zinc-900 p-4 shadow-2xl sm:max-h-[90dvh] sm:gap-6 sm:rounded-[30px] sm:p-6"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-zinc-400 transition hover:bg-zinc-800 hover:text-white sm:h-10 sm:w-10"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="pr-10 sm:pr-12">
          <h2 id={titleId} className="bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-lg font-bold tracking-tight text-transparent sm:text-xl">
            {title}
          </h2>
          {creator ? (
            <div className="mt-3 sm:mt-4">
              <CreatorIdentity creator={creator} />
            </div>
          ) : null}
          {actions ? (
            <div className="mt-3 flex flex-wrap gap-2 sm:mt-4 sm:gap-3">
              {actions}
            </div>
          ) : null}
        </div>

        <div className="preview-modal-media flex min-h-[220px] shrink-0 items-center justify-center overflow-hidden rounded-[20px] border border-white/5 bg-black/50 sm:min-h-[320px] sm:flex-1 sm:rounded-[24px]">
          {renderMedia()}
        </div>

        {visibleInputMedia.length > 0 ? (
          <div className="rounded-[20px] border border-white/5 bg-black/40 p-4 sm:rounded-[22px]">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Inputs used</div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {visibleInputMedia.map((item) => (
                <div key={item.id} className="min-w-0 rounded-[18px] border border-white/8 bg-white/[0.03] p-2">
                  {renderInputMediaPreview(item)}
                  <div className="mt-2 flex min-w-0 items-center gap-2 px-1 text-xs font-semibold text-zinc-200">
                    <span className="shrink-0 text-zinc-400">{getInputMediaIcon(item)}</span>
                    <span className="truncate">{item.label}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {mediaType !== 'text' && hasBody ? (
          <div className="rounded-[20px] border border-white/5 bg-black/40 p-4 sm:rounded-[22px]">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Note</div>
            <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-relaxed text-zinc-300 custom-scrollbar">
              {trimmedBody}
            </p>
          </div>
        ) : null}

        <div className="rounded-[20px] border border-white/5 bg-black/40 p-4 sm:rounded-[22px]">
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">
              {mediaType === 'text' ? 'Workflow notes' : 'Prompt'}
            </div>
            {hasPrompt ? (
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="inline-flex items-center gap-2 self-start rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                aria-live="polite"
              >
                {copyState === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Try again' : 'Copy prompt'}
              </button>
            ) : null}
          </div>
          <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap pr-2 text-sm leading-relaxed text-zinc-300 [overflow-wrap:anywhere] custom-scrollbar">
            {hasPrompt ? trimmedPrompt : mediaType === 'text' ? 'No extra notes available' : 'No prompt available'}
          </p>
        </div>
      </div>
    </div>,
    portalRoot
  );
}
