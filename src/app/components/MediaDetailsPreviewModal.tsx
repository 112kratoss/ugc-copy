'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, Film, Image as ImageIcon, Maximize2, Volume2, X } from 'lucide-react';
import { createPortal } from 'react-dom';

import CreatorIdentity from '@/app/components/CreatorIdentity';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import type { ShowcaseCreator } from '@/lib/showcase';

export type MediaDetailsType = 'image' | 'video' | 'audio' | 'text';
type PreviewableMediaType = Exclude<MediaDetailsType, 'text'>;

interface ActiveMediaPreview {
  mediaType: PreviewableMediaType;
  src: string;
  title: string;
  alt: string;
}

export interface MediaDetailsAdditionalMediaItem extends ActiveMediaPreview {
  id: string;
}

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
  additionalMedia?: MediaDetailsAdditionalMediaItem[] | null;
  creator?: ShowcaseCreator;
  metadata?: Array<{
    label: string;
    value: string;
  }>;
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
  additionalMedia,
  creator,
  metadata,
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
      additionalMedia={additionalMedia}
      creator={creator}
      metadata={metadata}
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
  additionalMedia,
  creator,
  metadata,
  actions,
}: Omit<MediaDetailsPreviewModalProps, 'isOpen'>) {
  const titleId = useId();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [activeMediaPreview, setActiveMediaPreview] = useState<ActiveMediaPreview | null>(null);
  const portalRoot = typeof document === 'undefined' ? null : document.body;
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trimmedPrompt = prompt?.trim() ?? '';
  const trimmedBody = body?.trim() ?? '';
  const hasPrompt = trimmedPrompt.length > 0;
  const hasBody = trimmedBody.length > 0;
  const visibleInputMedia = (inputMedia ?? []).filter((item) => Boolean(item.url));
  const visibleAdditionalMedia = (additionalMedia ?? []).filter((item) => Boolean(item.src));
  const visibleMetadata = (metadata ?? []).filter((item) => item.value.trim().length > 0);
  const recipeItems = [
    hasPrompt ? 'Prompt' : null,
    hasBody && mediaType !== 'text' ? 'Notes' : null,
    visibleInputMedia.length > 0 ? `${visibleInputMedia.length} input${visibleInputMedia.length === 1 ? '' : 's'}` : null,
    visibleAdditionalMedia.length > 0 ? `${visibleAdditionalMedia.length} more output${visibleAdditionalMedia.length === 1 ? '' : 's'}` : null,
  ].filter((item): item is string => Boolean(item));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (activeMediaPreview) {
          setActiveMediaPreview(null);
          return;
        }

        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMediaPreview, onClose]);

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

  const openMediaPreview = (preview: ActiveMediaPreview) => {
    setActiveMediaPreview(preview);
  };

  const renderExpandedMedia = (preview: ActiveMediaPreview) => {
    if (preview.mediaType === 'image') {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.src}
          alt={preview.alt}
          className="max-h-[calc(100dvh-7rem)] max-w-full object-contain"
        />
      );
    }

    if (preview.mediaType === 'audio') {
      return (
        <div className="w-full max-w-xl rounded-[24px] border border-white/10 bg-zinc-950 p-5">
          <div className="mb-4 flex items-center gap-3 text-sm font-semibold text-white">
            <Volume2 className="h-4 w-4 text-emerald-200" />
            {preview.title}
          </div>
          <audio src={preview.src} controls autoPlay className="w-full" />
        </div>
      );
    }

    return (
      <video
        src={preview.src}
        controls
        autoPlay
        playsInline
        className="max-h-[calc(100dvh-7rem)] max-w-full object-contain"
      />
    );
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
        <button
          type="button"
          onClick={() => openMediaPreview({ mediaType: 'image', src, title, alt })}
          className="group relative flex w-full items-center justify-center"
          aria-label="Open full image preview"
          title="Open full image preview"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="preview-modal-visual max-h-[40dvh] w-full object-contain sm:max-h-[48vh]" />
          <span className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/55 text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100 group-focus-visible:opacity-100">
            <Maximize2 className="h-4 w-4" />
          </span>
        </button>
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
        className="preview-modal-visual max-h-[40dvh] w-full object-contain sm:max-h-[48vh]"
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
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl bg-black/70">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.url} alt={item.label} className="h-full w-full object-contain" />
        </div>
      );
    }

    if (item.mediaType === 'audio') {
      return (
        <div className="flex aspect-square w-full items-center justify-center rounded-2xl border border-white/8 bg-zinc-950/80 p-3 text-emerald-100">
          <Volume2 className="h-5 w-5" />
        </div>
      );
    }

    return (
      <video
        src={item.url}
        muted
        playsInline
        preload="metadata"
        className="aspect-square w-full rounded-2xl bg-black/70 object-contain"
      />
    );
  };

  const renderAdditionalMediaPreview = (item: MediaDetailsAdditionalMediaItem) => {
    if (item.mediaType === 'image') {
      return (
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl bg-black/70">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.src} alt={item.alt} loading="lazy" decoding="async" className="h-full w-full object-contain" />
        </div>
      );
    }

    if (item.mediaType === 'audio') {
      return (
        <div className="flex aspect-square w-full items-center justify-center rounded-2xl border border-white/8 bg-zinc-950/80 p-3 text-emerald-100">
          <Volume2 className="h-5 w-5" />
        </div>
      );
    }

    return (
      <video
        src={item.src}
        muted
        playsInline
        preload="metadata"
        className="aspect-square w-full rounded-2xl bg-black/70 object-contain"
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
        className="preview-modal-panel relative flex max-h-[calc(100dvh-1.5rem)] min-w-0 w-[calc(100vw-1.5rem)] max-w-4xl flex-col gap-4 overflow-y-auto overscroll-contain rounded-[28px] border border-white/10 bg-zinc-950 p-4 shadow-2xl shadow-black/70 sm:max-h-[90dvh] sm:gap-5 sm:rounded-[30px] sm:p-6"
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
          <h2 id={titleId} className="text-lg font-bold tracking-tight text-white sm:text-xl">
            {title}
          </h2>
          {visibleMetadata.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {visibleMetadata.map((item) => (
                <span
                  key={`${item.label}:${item.value}`}
                  title={item.label}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-zinc-300"
                >
                  {item.value}
                </span>
              ))}
            </div>
          ) : null}
          {creator ? (
            <div className="mt-3 sm:mt-4">
              <CreatorIdentity creator={creator} />
            </div>
          ) : null}
        </div>

        <div className="preview-modal-media flex min-h-[220px] shrink-0 items-center justify-center overflow-hidden rounded-[22px] border border-white/8 bg-black/70 shadow-inner sm:min-h-[320px] sm:flex-1 sm:rounded-[24px]">
          {renderMedia()}
        </div>

        {actions ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}

        <details
          open
          className="group rounded-[22px] border border-white/8 bg-black/45 p-4 sm:rounded-[24px] sm:p-5"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Saved creation setup</div>
              <div className="mt-1 text-sm text-zinc-300">
                {recipeItems.length > 0 ? recipeItems.join(' + ') : 'Saved generation details'}
              </div>
            </div>
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 transition group-open:rotate-180">
              <ChevronDown className="h-4 w-4" />
            </span>
          </summary>

          <div className="mt-4 grid gap-4">
            {visibleAdditionalMedia.length > 0 ? (
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-600">Additional outputs</div>
                <div className="mt-3 flex flex-wrap gap-3">
                  {visibleAdditionalMedia.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openMediaPreview(item)}
                      className="group w-[calc(50%-0.375rem)] min-w-0 rounded-[18px] border border-white/8 bg-white/[0.03] p-2 text-left transition hover:border-white/18 hover:bg-white/[0.06] sm:w-36"
                      aria-label={`Open ${item.title}`}
                    >
                      {renderAdditionalMediaPreview(item)}
                      <div className="mt-2 flex min-w-0 items-center gap-2 px-1 text-xs font-semibold text-zinc-200">
                        <span className="truncate">{item.title}</span>
                        <Maximize2 className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {visibleInputMedia.length > 0 ? (
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-600">Inputs used</div>
                <div className="mt-3 flex flex-wrap gap-3">
                  {visibleInputMedia.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (!item.url) {
                          return;
                        }

                        openMediaPreview({
                          mediaType: item.mediaType,
                          src: item.url,
                          title: item.label,
                          alt: item.label,
                        });
                      }}
                      className="group w-[calc(50%-0.375rem)] min-w-0 rounded-[18px] border border-white/8 bg-white/[0.03] p-2 text-left transition hover:border-white/18 hover:bg-white/[0.06] sm:w-36"
                    >
                      {renderInputMediaPreview(item)}
                      <div className="mt-2 flex min-w-0 items-center gap-2 px-1 text-xs font-semibold text-zinc-200">
                        <span className="shrink-0 text-zinc-400">{getInputMediaIcon(item)}</span>
                        <span className="truncate">{item.label}</span>
                        <Maximize2 className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {mediaType !== 'text' && hasBody ? (
              <div className="rounded-[20px] border border-white/5 bg-black/40 p-4 sm:rounded-[22px]">
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Notes</div>
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
        </details>

        {activeMediaPreview ? (
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 p-4 backdrop-blur-md"
            onClick={() => setActiveMediaPreview(null)}
          >
            <div
              className="relative flex max-h-full w-[calc(100vw-2rem)] max-w-6xl items-center justify-center"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setActiveMediaPreview(null)}
                className="absolute right-3 top-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/65 text-zinc-300 transition hover:bg-zinc-900 hover:text-white"
                aria-label="Close full media preview"
              >
                <X className="h-5 w-5" />
              </button>
              <div className="flex min-h-[220px] w-full items-center justify-center rounded-[24px] border border-white/10 bg-black p-4 sm:min-h-[420px] sm:p-6">
                {renderExpandedMedia(activeMediaPreview)}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    portalRoot
  );
}
