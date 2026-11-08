'use client';

import { Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { StudioMediaPreviewType } from '@/components/CreatorStudio';
import InlineMediaVideo from '@/components/InlineMediaVideo';
import { getFocusableElements } from '@/lib/focusable-elements';
import { isSignedMediaUrlExpiring } from '@/lib/template-run-stable-media';

const PREVIEW_VISUAL_CLASS = 'preview-modal-visual max-h-[45dvh] w-full object-contain sm:max-h-[68vh]';

/**
 * The picture or clip itself. A link with five minutes or less to live (a remix's are signed for
 * an hour, and a new player on a lapsed one stayed blank) waits for the one `renewSrc` gives for
 * it; any other, a blob, a public link or a fresh one, is drawn at once. Mounted for each link as
 * the preview opens it (keyed by `src`), so each opening decides again.
 */
function StudioPreviewMedia({
  mediaType,
  src,
  alt,
  renewSrc,
}: {
  mediaType: StudioMediaPreviewType;
  src: string;
  alt: string;
  renewSrc?: (src: string) => Promise<string>;
}) {
  // Read once, as it opens: null while a lapsing link waits for its renewal.
  const [shown, setShown] = useState<string | null>(() => (
    renewSrc && isSignedMediaUrlExpiring(src) ? null : src
  ));
  useEffect(() => {
    if (shown !== null || !renewSrc) return;
    let live = true;
    renewSrc(src).then(
      (renewed) => {
        if (live) setShown(renewed);
      },
      () => {
        if (live) setShown(src);
      },
    );
    return () => {
      live = false;
    };
  }, [renewSrc, shown, src]);

  if (shown === null) {
    return <Loader2 aria-label="Loading preview" className="h-8 w-8 animate-spin text-zinc-500" />;
  }
  return mediaType === 'image' ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={shown} alt={alt} className={PREVIEW_VISUAL_CLASS} />
  ) : (
    <InlineMediaVideo src={shown} controls autoPlay loop className={PREVIEW_VISUAL_CLASS} />
  );
}

/**
 * A creator's picture or clip at full size. As the details viewer does, it takes the focus as
 * it opens, keeps Tab among its own controls, closes on Escape and hands the focus back as it
 * goes: left on the page under it, the focus kept that page in the tab order, and a run's end
 * moved it to the canvas behind the preview.
 */
export function StudioMediaPreviewModal({
  isOpen,
  onClose,
  mediaType,
  src,
  alt,
  title,
  footer,
  renewSrc,
}: {
  isOpen: boolean;
  onClose: () => void;
  mediaType: StudioMediaPreviewType;
  src: string | null;
  alt: string;
  title: string;
  footer?: ReactNode;
  /** A link to `src`'s file that opens now, asked only for a link about to lapse (a remix page's last an hour). */
  renewSrc?: (src: string) => Promise<string>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const open = isOpen && Boolean(src);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // A field inside that took the key for itself (a name being typed, taken back) keeps it open.
        if (!event.defaultPrevented) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      const focusable = getFocusableElements(dialog);
      if (!dialog || focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open || !src || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="preview-modal-overlay fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="preview-modal-panel relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col gap-4 overflow-y-auto overscroll-contain rounded-3xl border border-white/10 bg-zinc-900 p-4 shadow-2xl outline-none sm:max-h-[90dvh] sm:gap-6 sm:p-6"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-zinc-400 transition hover:bg-zinc-800 hover:text-white sm:h-10 sm:w-10"
          aria-label="Close preview"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 id={titleId} className="pr-10 text-lg font-bold tracking-tight text-white sm:pr-12 sm:text-xl">{title}</h2>

        <div className="preview-modal-media flex min-h-[220px] shrink-0 items-center justify-center overflow-hidden rounded-ui-xl border border-white/5 bg-black/50 sm:min-h-[320px] sm:flex-1">
          <StudioPreviewMedia key={src} mediaType={mediaType} src={src} alt={alt} renewSrc={renewSrc} />
        </div>

        {footer ? (
          <div className="rounded-2xl border border-white/5 bg-black/40 p-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
