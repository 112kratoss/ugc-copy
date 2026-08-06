'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface ComposerMediaLightboxItem {
  id: string;
  previewUrl: string | null | undefined;
  mediaKind: 'image' | 'video';
  originalName: string | null;
}

interface ComposerMediaLightboxProps {
  items: ComposerMediaLightboxItem[];
  activeIndex: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

/**
 * How a composer media slot is named everywhere the user can see it: the strip
 * card, the lightbox heading, and the screen-reader labels all agree that slot
 * zero is the cover.
 */
export function getComposerMediaLabel(index: number) {
  return index === 0 ? 'Cover' : `Media ${index + 1}`;
}

export default function ComposerMediaLightbox({
  items,
  activeIndex,
  onClose,
  onNavigate,
}: ComposerMediaLightboxProps) {
  const isOpen = activeIndex !== null && activeIndex >= 0 && activeIndex < items.length;

  if (!isOpen) {
    return null;
  }

  // Mounted only while open so the escape/scroll-lock effects live exactly as
  // long as the overlay does, and a closed lightbox costs nothing.
  return (
    <ComposerMediaLightboxDialog
      items={items}
      activeIndex={activeIndex}
      onClose={onClose}
      onNavigate={onNavigate}
    />
  );
}

function ComposerMediaLightboxDialog({
  items,
  activeIndex,
  onClose,
  onNavigate,
}: ComposerMediaLightboxProps & { activeIndex: number }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const portalRoot = typeof document === 'undefined' ? null : document.body;

  const lastIndex = items.length - 1;

  // Re-registered whenever the active index moves. Cheaper and far easier to
  // follow than holding the index in a ref to keep one listener alive.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'ArrowLeft' && activeIndex > 0) {
        event.preventDefault();
        onNavigate(activeIndex - 1);
        return;
      }

      if (event.key === 'ArrowRight' && activeIndex < lastIndex) {
        event.preventDefault();
        onNavigate(activeIndex + 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, lastIndex, onClose, onNavigate]);

  // The page behind a full-screen overlay must not scroll under it.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Send focus into the dialog, then hand it back to whatever opened it so a
  // keyboard user does not land at the top of the document on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  const activeItem = items[activeIndex];
  const label = getComposerMediaLabel(activeIndex);
  const hasPrevious = activeIndex > 0;
  const hasNext = activeIndex < items.length - 1;

  if (!portalRoot || !activeItem) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="relative flex max-h-full w-[calc(100vw-2rem)] max-w-5xl flex-col gap-3 outline-none"
      >
        <div className="flex items-center gap-3 pr-1">
          <h2 id={titleId} className="text-sm font-bold tracking-tight text-white">
            {label}
            {activeItem.originalName ? (
              <span className="ml-2 font-medium text-zinc-400">{activeItem.originalName}</span>
            ) : null}
          </h2>
          <span className="text-xs font-semibold text-zinc-500">
            {activeIndex + 1} of {items.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close media preview"
            className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/65 text-zinc-300 transition hover:bg-zinc-900 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="relative flex min-h-[220px] w-full items-center justify-center rounded-[24px] border border-white/10 bg-black p-4 sm:min-h-[420px] sm:p-6">
          {activeItem.mediaKind === 'video' ? (
            <video
              key={activeItem.id}
              src={activeItem.previewUrl ?? undefined}
              controls
              autoPlay
              playsInline
              className="max-h-[calc(100dvh-11rem)] max-w-full object-contain"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={activeItem.id}
              src={activeItem.previewUrl ?? undefined}
              alt={`${label} preview`}
              className="max-h-[calc(100dvh-11rem)] max-w-full object-contain"
            />
          )}

          {hasPrevious ? (
            <button
              type="button"
              onClick={() => onNavigate(activeIndex - 1)}
              aria-label="Show previous media"
              className="absolute left-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-zinc-200 transition hover:bg-zinc-900 hover:text-white"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : null}

          {hasNext ? (
            <button
              type="button"
              onClick={() => onNavigate(activeIndex + 1)}
              aria-label="Show next media"
              className="absolute right-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-zinc-200 transition hover:bg-zinc-900 hover:text-white"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    portalRoot
  );
}
