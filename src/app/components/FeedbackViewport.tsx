'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

import {
  dismissToast,
  readFeedbackSnapshot,
  readServerFeedbackSnapshot,
  resolveConfirmation,
  subscribeToFeedback,
  type PendingConfirmation,
  type ToastRecord,
} from './feedback-state';

/**
 * Renders toasts and the confirmation dialog for the whole app. Mounted once
 * in the root layout; everything else talks to it through `feedback-state`.
 *
 * Shared by public and authenticated routes, so the layout classes live in
 * globals.css rather than as responsive utilities.
 */
export default function FeedbackViewport() {
  const { toasts, confirmation } = useSyncExternalStore(
    subscribeToFeedback,
    readFeedbackSnapshot,
    readServerFeedbackSnapshot,
  );

  return (
    <>
      <div className="ui-toast-viewport" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} />
        ))}
      </div>
      {confirmation ? <ConfirmDialog confirmation={confirmation} /> : null}
    </>
  );
}

const TOAST_TONE_CLASS: Record<ToastRecord['tone'], string> = {
  success: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-50',
  error: 'border-rose-400/25 bg-rose-500/10 text-rose-50',
  info: 'border-white/12 bg-white/[0.06] text-zinc-100',
};

function ToastIcon({ tone }: { tone: ToastRecord['tone'] }) {
  if (tone === 'success') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />;
  if (tone === 'error') return <AlertTriangle className="h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />;
  return <Info className="h-4 w-4 shrink-0 text-zinc-300" aria-hidden="true" />;
}

function Toast({ toast }: { toast: ToastRecord }) {
  useEffect(() => {
    const timeout = window.setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => window.clearTimeout(timeout);
  }, [toast.durationMs, toast.id]);

  return (
    <div className={`ui-toast ${TOAST_TONE_CLASS[toast.tone]}`}>
      <ToastIcon tone={toast.tone} />
      <p className="min-w-0 flex-1 text-sm leading-5">{toast.message}</p>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss notification"
        className="ui-focus-ring -m-1 shrink-0 rounded-full p-1 text-current opacity-70 transition hover:opacity-100"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function ConfirmDialog({ confirmation }: { confirmation: PendingConfirmation }) {
  const { id, request } = confirmation;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const isDanger = request.tone === 'danger';

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // The safe choice takes focus, so Enter never confirms by accident.
    const focusFrame = window.requestAnimationFrame(() => cancelRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        resolveConfirmation(id, false);
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      // Two focusable controls: keep Tab cycling between them.
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [id]);

  return (
    <div
      className="ui-confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          resolveConfirmation(id, false);
        }
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`ui-confirm-title-${id}`}
        aria-describedby={`ui-confirm-message-${id}`}
        className="ui-confirm-dialog"
      >
        <h2 id={`ui-confirm-title-${id}`} className="text-lg font-semibold leading-6 text-white">
          {request.title}
        </h2>
        <p id={`ui-confirm-message-${id}`} className="mt-2 text-sm leading-6 text-zinc-300">
          {request.message}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => resolveConfirmation(id, false)}
            className="ui-focus-ring inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => resolveConfirmation(id, true)}
            className={`ui-focus-ring inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold transition ${
              isDanger
                ? 'bg-rose-500 text-white hover:bg-rose-400'
                : 'bg-white text-black hover:bg-zinc-200'
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
