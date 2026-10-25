'use client';

import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

import {
  dismissToast,
  readFeedbackSnapshot,
  readServerFeedbackSnapshot,
  readServerToastHost,
  readToastHost,
  resolveConfirmation,
  resolvePublicIdentity,
  subscribeToFeedback,
  subscribeToToastHost,
  type PendingConfirmation,
  type ToastRecord,
} from './feedback-state';

// Asked for only by an owner making a post public before their profile can
// publish, so it is not part of the bundle every page loads with this viewport.
// React's own lazy, as `next/dynamic` is in the app router: a failed load is
// thrown to the boundary below, under vitest too, where `next/dynamic` is the
// pages router's loader and hands the failure to its fallback instead.
const PublicIdentityDialog = lazy(() => import('./PublicIdentityDialog'));

/**
 * The question's load can fail: a deploy rotated the chunk names while the tab
 * was open, or the connection was down as it was asked. React.lazy throws that
 * to the nearest error boundary, and nothing above this viewport
 * in the root layout is one, so the whole page would give way to Next's
 * generic client-exception page, as Alerts' did (`SignedInAlertsBoundary`).
 * Kept here instead: the question is answered `unavailable`, and its caller
 * says what it would have said without asking.
 */
class PublicIdentityDialogBoundary extends Component<{ id: number; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Failed to load the name-and-handle question:', error);
    resolvePublicIdentity(this.props.id, { status: 'unavailable' });
    // Caught here, it never reaches Next's own reportError, which is what
    // Sentry hears; hand it on as an uncaught one would be.
    window.reportError?.(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Renders toasts, the confirmation dialog and the name-and-handle question
 * for the whole app. Mounted once in the root layout; everything else talks to
 * it through `feedback-state`.
 *
 * Shared by public and authenticated routes, so the layout classes live in
 * globals.css rather than as responsive utilities.
 *
 * While a dialog hosts the toasts (`setToastHost`: the reel), they are drawn
 * inside it, where a screen reader can reach them past its `aria-modal`, its
 * focus order includes them, and `.ui-toast-viewport-in-dialog` places them
 * below its header and under its ⋯ menu.
 */
export default function FeedbackViewport() {
  const { toasts, confirmation, publicIdentity } = useSyncExternalStore(
    subscribeToFeedback,
    readFeedbackSnapshot,
    readServerFeedbackSnapshot,
  );
  const host = useSyncExternalStore(subscribeToToastHost, readToastHost, readServerToastHost);

  const viewport = (
    <div
      className={host ? 'ui-toast-viewport ui-toast-viewport-in-dialog' : 'ui-toast-viewport'}
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );

  return (
    <>
      {host ? createPortal(viewport, host) : viewport}
      {/* A child of <body> added when it opens, wherever the viewport sits: a
          modal that makes the rest of the page inert while it is up (the
          composer's resource editor) knew nothing of it then, so it can still
          be pressed and focused over that modal. */}
      {confirmation ? createPortal(<ConfirmDialog confirmation={confirmation} />, document.body) : null}
      {publicIdentity
        ? createPortal(
          <PublicIdentityDialogBoundary key={publicIdentity.id} id={publicIdentity.id}>
            <Suspense fallback={null}>
              <PublicIdentityDialog pending={publicIdentity} />
            </Suspense>
          </PublicIdentityDialogBoundary>,
          document.body,
        )
        : null}
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

/** How often a counting in-view-only toast looks again at what is drawn over it. */
const TOAST_COVER_CHECK_MS = 400;

/**
 * Whether something is drawn over the toast:
 * - another modal dialog: any `aria-modal` one that does not hold the toast (a
 *   confirmation, the reel's reference preview), which a screen reader cannot
 *   reach past either; the dialog holding it (the reel) does not count;
 * - full screen: the browser's top layer, or iOS Safari's own video player;
 * - anything else over its words, sampled across them (an open menu, such as
 *   the reel's ⋯ on a phone).
 */
function isToastCovered(toast: HTMLElement | null, videoFullScreen: boolean) {
  if (!toast) return true;
  if (Array.from(document.querySelectorAll('[aria-modal="true"]')).some((dialog) => !dialog.contains(toast))) {
    return true;
  }
  const fullScreen = document.fullscreenElement;
  if (videoFullScreen || (fullScreen && !fullScreen.contains(toast))) return true;

  const words = toast.querySelector('p') ?? toast;
  const box = words.getBoundingClientRect();
  if (typeof document.elementFromPoint !== 'function' || box.width === 0 || box.height === 0) return false;
  const y = box.top + box.height / 2;
  return [0.05, 0.5, 0.95].some((across) => {
    const drawn = document.elementFromPoint(box.left + box.width * across, y);
    return drawn !== null && !toast.contains(drawn);
  });
}

/**
 * Whether a toast can be seen now: its window has the focus (read when it
 * mounts, since a save's answer can arrive after the viewer has gone to
 * another window) and nothing is drawn over it (`isToastCovered`), looked at
 * again whenever the page changes, the browser goes full screen or out of it,
 * and every `TOAST_COVER_CHECK_MS` (a menu can slide over it without a change
 * the observer hears). Followed only while `enabled`.
 */
function useToastInView(enabled: boolean, toastRef: RefObject<HTMLElement | null>) {
  const [windowFocused, setWindowFocused] = useState(() => !enabled || document.hasFocus());
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let videoFullScreen = false;
    const blur = () => setWindowFocused(false);
    const focus = () => setWindowFocused(true);
    const check = () => setCovered(isToastCovered(toastRef.current, videoFullScreen));
    // iOS Safari plays a video full screen in its own player; the events fire
    // on the video and do not bubble.
    const videoEnters = () => {
      videoFullScreen = true;
      check();
    };
    const videoLeaves = () => {
      videoFullScreen = false;
      check();
    };
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    document.addEventListener('fullscreenchange', check);
    document.addEventListener('webkitbeginfullscreen', videoEnters, true);
    document.addEventListener('webkitendfullscreen', videoLeaves, true);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'class', 'style', 'hidden', 'open'],
    });
    const interval = window.setInterval(check, TOAST_COVER_CHECK_MS);
    return () => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      document.removeEventListener('fullscreenchange', check);
      document.removeEventListener('webkitbeginfullscreen', videoEnters, true);
      document.removeEventListener('webkitendfullscreen', videoLeaves, true);
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, [enabled, toastRef]);

  return !enabled || (windowFocused && !covered);
}

function Toast({ toast }: { toast: ToastRecord }) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const inViewOnly = toast.inViewOnly === true;
  const inView = useToastInView(inViewOnly, elementRef);

  // When it first appeared on this page, for its close guard.
  const shownAtRef = useRef<number | null>(null);
  useEffect(() => {
    shownAtRef.current ??= Date.now();
  }, []);

  // Its time, counted while it can be seen: what ran before a pause is kept.
  const remainingRef = useRef(toast.durationMs);
  useEffect(() => {
    if (!inView) return undefined;
    const startedAt = Date.now();
    const timeout = window.setTimeout(() => dismissToast(toast.id, 'expired'), remainingRef.current);
    return () => {
      window.clearTimeout(timeout);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [inView, toast.id]);

  // Leaving the page takes an in-view-only toast down unread, as leaving the
  // app takes the app's notice down.
  useEffect(() => {
    if (!inViewOnly) return undefined;
    const leave = () => {
      if (document.visibilityState === 'hidden') dismissToast(toast.id, 'interrupted');
    };
    leave();
    document.addEventListener('visibilitychange', leave);
    return () => document.removeEventListener('visibilitychange', leave);
  }, [inViewOnly, toast.id]);

  const close = () => {
    const shownAt = shownAtRef.current;
    if (toast.closeGuardMs && shownAt !== null && Date.now() - shownAt < toast.closeGuardMs) return;
    dismissToast(toast.id);
  };

  return (
    <div ref={elementRef} className={`ui-toast ${TOAST_TONE_CLASS[toast.tone]}`}>
      <ToastIcon tone={toast.tone} />
      <p className="min-w-0 flex-1 text-sm leading-5">{toast.message}</p>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss notification"
        className="ui-focus-ring -m-1 shrink-0 rounded-full p-1 text-current opacity-70 transition hover:opacity-100"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The page an address names: a change of hash alone stays on it. */
function readAddress() {
  return `${window.location.pathname}${window.location.search}`;
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
    // The safe choice takes focus, so Enter never confirms by accident. Without
    // scrolling: the phone's sheet starts below the window, and focusing it
    // there scrolled the backdrop to it, so the sheet jumped into place in one
    // frame instead of sliding up.
    const focusFrame = window.requestAnimationFrame(() => cancelRef.current?.focus({ preventScroll: true }));
    // Where it was asked: a Back that leaves this address has left the page
    // the question was about (the reel it would unlock, the creator it would
    // block), and its answer would act for a page that is gone.
    const askedAt = readAddress();

    // Every key is the question's while it is up: heard first (on the window,
    // in the capture phase) and kept from everything beneath it, so a modal
    // under it never takes its Escape for its own or pulls Tab back into
    // itself.
    const handleKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
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

    const handlePopState = () => {
      if (readAddress() !== askedAt) {
        resolveConfirmation(id, false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('popstate', handlePopState);
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
        {/* Only a step that cannot be taken back carries a mark, so the mark
            keeps its meaning. */}
        {isDanger ? (
          <span className="ui-confirm-icon">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
        ) : null}
        <h2 id={`ui-confirm-title-${id}`} className="ui-confirm-title">
          {request.title}
        </h2>
        <p id={`ui-confirm-message-${id}`} className="ui-confirm-message">
          {request.message}
        </p>
        <div className="ui-confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => resolveConfirmation(id, false)}
            className="ui-button ui-button-secondary ui-focus-ring"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => resolveConfirmation(id, true)}
            className={`ui-button ui-focus-ring ${isDanger ? 'ui-button-danger' : 'ui-button-primary'}`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
