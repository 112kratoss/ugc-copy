'use client';

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import type { ShowcaseMediaItem } from '@/lib/showcase';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface FeedMediaLightboxProps {
  /** The post's feed title; the dialog's accessible name. */
  title: string;
  mediaItems: ShowcaseMediaItem[];
  /** The slide the viewer clicked, so the lightbox opens on what they pointed at. */
  initialIndex: number;
  onClose: () => void;
}

/**
 * Expands a feed post's media, the way clicking an image on Reddit does: the
 * media fills the screen and nothing else about the page changes. Clicking
 * anywhere else on the card opens the post page instead — this is the one
 * region of a card that does not navigate.
 *
 * No URL is written. Reddit's `#lightbox` hangs off the permalink page, not the
 * feed, and a router push here would spend an RSC round trip on `/` (which is
 * statically prerendered with `revalidate = 60`) just to show an image. The
 * trade is that browser Back leaves the feed rather than closing this.
 *
 * Focus trap, Escape, backdrop click and scroll-lock save/restore are carried
 * over from the intercepted-post overlay this replaced.
 */
export default function FeedMediaLightbox({
  title,
  mediaItems,
  initialIndex,
  onClose,
}: FeedMediaLightboxProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // Callers pass an inline arrow, so a new identity arrives on every parent
  // render. Reading it through a ref keeps the effect below mount-only —
  // re-running it would re-capture the focus target (by then the dialog
  // itself) and lose the element that opened us.
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // The reel viewer listens for Escape on the window too, so mark the
    // document as owned while this is on top — otherwise one Escape would
    // collapse both layers at once.
    document.body.dataset.showcaseOverlayOpen = 'true';
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // A nested dialog (report, Razorpay) owns Escape while it is open.
        if (document.querySelector('[data-showcase-overlay-nested="true"]')) {
          return;
        }
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // Native video controls bind the arrows to seeking, and a text field
        // binds them to the caret — neither should change slide.
        const active = document.activeElement;
        if (active instanceof HTMLVideoElement
          || active instanceof HTMLInputElement
          || active instanceof HTMLTextAreaElement) {
          return;
        }
        // Driving the carousel's own arrow buttons keeps one source of truth
        // for the index and inherits their disabled state at either end. A
        // programmatic click does not move focus.
        const control = dialogRef.current?.querySelector<HTMLButtonElement>(
          event.key === 'ArrowLeft' ? '[data-carousel-prev]' : '[data-carousel-next]'
        );
        if (control && !control.disabled) {
          event.preventDefault();
          control.click();
        }
        return;
      }

      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      delete document.body.dataset.showcaseOverlayOpen;
      const focusTarget = previouslyFocusedRef.current;
      window.queueMicrotask(() => {
        if (focusTarget?.isConnected) {
          focusTarget.focus();
        }
      });
    };
  }, []);

  return (
    <div
      data-testid="feed-media-lightbox"
      className="fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/90 p-4 backdrop-blur-sm sm:p-6"
      onClick={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="ui-enter relative flex h-[min(92dvh,100%)] w-full max-w-[min(96vw,1280px)] flex-col outline-none"
      >
        <button
          type="button"
          onClick={() => onCloseRef.current()}
          aria-label="Close media"
          className="ui-focus-ring absolute right-3 top-3 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/70 text-zinc-200 backdrop-blur-md transition hover:border-white/25 hover:text-white active:scale-[0.97]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        {/*
          `reel` is the only mode that leaves the frame's height to the caller —
          `feed` and `detail` both stamp an inline aspect-ratio on the viewport,
          which would letterbox inside an already-letterboxed dialog. It also
          gives native video controls, unmuted playback, and full-resolution
          images rather than the feed's preview renditions.

          No `onOpen`: it renders a full-bleed transparent button over the media
          that would swallow every click meant for the video controls.
        */}
        <ShowcaseMediaCarousel
          mediaItems={mediaItems}
          title={title}
          mode="reel"
          initialIndex={initialIndex}
          className="flex-1 min-h-0"
          viewportClassName="w-full"
        />
      </div>
    </div>
  );
}
