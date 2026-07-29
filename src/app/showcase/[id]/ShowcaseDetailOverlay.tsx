'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The modal shell for an intercepted post. The list underneath stays mounted,
 * so closing is a history step back rather than a fresh navigation — the feed
 * returns with its scroll position and loaded pages intact.
 *
 * Focus trap, Escape, backdrop click, and scroll-lock save/restore follow
 * PublishToShowcaseModal, the repo's most complete dialog. Escape and backdrop
 * yield while a nested surface is open (Razorpay's checkout iframe, the report
 * dialog) so the inner layer closes first.
 */
export default function ShowcaseDetailOverlay({
  title,
  fallbackHref = '/showcase',
  children,
}: {
  title: string;
  /** Used only if this overlay somehow has no history entry to step back to. */
  fallbackHref?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    // An intercepted render implies a soft navigation, so there is normally an
    // entry to step back to and the list behind stays mounted. With no history
    // to consume, stepping back would do nothing and strand the viewer inside
    // an overlay that will not close — so fall back to a real navigation.
    if (window.history.length > 1) {
      router.back();
      return;
    }

    router.replace(fallbackHref);
  }, [fallbackHref, router]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // The reel viewer can still be open underneath (its "Post details" link
    // lands here). It listens for Escape on the window too, so mark the
    // document as owned while this overlay is on top — otherwise one Escape
    // would collapse both layers at once.
    document.body.dataset.showcaseOverlayOpen = 'true';
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // A nested dialog (report, Razorpay) owns Escape while it is open.
        if (document.querySelector('[data-showcase-overlay-nested="true"]')) {
          return;
        }
        event.preventDefault();
        close();
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
  }, [close]);

  return (
    <div
      data-testid="showcase-detail-overlay"
      className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-black/80 p-0 backdrop-blur-sm sm:p-6"
      onClick={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="ui-enter relative mx-auto w-full max-w-[1180px] overflow-hidden rounded-none border border-white/10 bg-[#050506] shadow-[0_40px_120px_rgba(0,0,0,0.6)] outline-none sm:rounded-[28px]"
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close post"
          className="ui-focus-ring absolute right-3 top-3 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/70 text-zinc-200 backdrop-blur-md transition hover:border-white/25 hover:text-white active:scale-[0.97]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        {children}
      </div>
    </div>
  );
}
