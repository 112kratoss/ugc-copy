/**
 * A module-level store for transient feedback: toasts and confirmation
 * dialogs. `FeedbackViewport` subscribes and renders; any client code calls
 * `pushToast` / `requestConfirmation` without needing a provider above it,
 * which keeps the root layout's hydration-pinned tree untouched.
 */

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastRecord {
  id: number;
  tone: ToastTone;
  message: string;
  durationMs: number;
  /**
   * How long after it appears a press on its close button is ignored: a press
   * that early was on its way to what sat there, not a reading of the toast.
   */
  closeGuardMs?: number;
  /**
   * Counts its time only while it can be seen: paused while the window is out
   * of focus or another modal dialog is drawn over it, and taken down unread
   * (`'interrupted'`) when the page is hidden. For a toast whose running out
   * stands for its having been read (the saver notice).
   */
  inViewOnly?: true;
}

export interface ConfirmationRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

export interface PendingConfirmation {
  id: number;
  request: ConfirmationRequest;
}

export interface FeedbackSnapshot {
  toasts: ToastRecord[];
  confirmation: PendingConfirmation | null;
}

const DEFAULT_TOAST_DURATION_MS = 4000;
const EMPTY_SNAPSHOT: FeedbackSnapshot = { toasts: [], confirmation: null };

type Listener = () => void;

let nextId = 1;
let snapshot: FeedbackSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<Listener>();
const confirmationResolvers = new Map<number, (confirmed: boolean) => void>();

/** How a toast went: closed by the viewer, out of time, or taken down unread by the code that showed it. */
export type ToastDismissal = 'closed' | 'expired' | 'interrupted';
const toastDismissHandlers = new Map<number, (how: ToastDismissal) => void>();

function commit(next: FeedbackSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function subscribeToFeedback(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readFeedbackSnapshot(): FeedbackSnapshot {
  return snapshot;
}

/**
 * Whether anything draws this store right now (the root layout's
 * `FeedbackViewport`). A toast pushed while nothing is subscribed is never
 * seen.
 */
export function hasFeedbackViewport() {
  return listeners.size > 0;
}

let toastHost: HTMLElement | null = null;
const hostListeners = new Set<Listener>();

/**
 * The open dialog that draws the toasts while it is up (the reel), or null for
 * the page. Inside an `aria-modal` dialog a toast drawn outside it is inert to
 * a screen reader and out of the dialog's focus order; the dialog also places
 * it clear of its own controls.
 */
export function setToastHost(element: HTMLElement | null) {
  if (toastHost === element) return;
  toastHost = element;
  hostListeners.forEach((listener) => listener());
}

export function subscribeToToastHost(listener: Listener) {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
}

export function readToastHost() {
  return toastHost;
}

export function readServerToastHost(): HTMLElement | null {
  return null;
}

/** The server and first client render must agree: nothing is showing. */
export function readServerFeedbackSnapshot(): FeedbackSnapshot {
  return EMPTY_SNAPSHOT;
}

export function pushToast(toast: {
  tone: ToastTone;
  message: string;
  durationMs?: number;
  closeGuardMs?: number;
  inViewOnly?: boolean;
  /** Told once, when the toast goes (not when tests reset the store). */
  onDismiss?: (how: ToastDismissal) => void;
}): number {
  const id = nextId++;
  if (toast.onDismiss) toastDismissHandlers.set(id, toast.onDismiss);
  commit({
    ...snapshot,
    toasts: [
      ...snapshot.toasts,
      {
        id,
        tone: toast.tone,
        message: toast.message,
        durationMs: toast.durationMs ?? DEFAULT_TOAST_DURATION_MS,
        ...(toast.closeGuardMs ? { closeGuardMs: toast.closeGuardMs } : {}),
        ...(toast.inViewOnly ? { inViewOnly: true as const } : {}),
      },
    ],
  });
  return id;
}

export function dismissToast(id: number, how: ToastDismissal = 'closed') {
  if (!snapshot.toasts.some((toast) => toast.id === id)) {
    return;
  }
  commit({ ...snapshot, toasts: snapshot.toasts.filter((toast) => toast.id !== id) });
  const onDismiss = toastDismissHandlers.get(id);
  toastDismissHandlers.delete(id);
  onDismiss?.(how);
}

/**
 * Ask the viewer to confirm. Resolves with their answer once `FeedbackViewport`
 * has shown the dialog and they have chosen. With no viewport mounted (a test
 * rendering a single component, for instance) it falls back to the native
 * dialog so the caller still gets an answer instead of hanging.
 *
 * An aborted `signal` answers "cancel" and takes the dialog down: for a
 * question that stops making sense, such as one asked by a component that has
 * since gone (`useConfirmation`).
 */
export function requestConfirmation(
  request: ConfirmationRequest,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const { signal } = options;
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  if (listeners.size === 0) {
    return Promise.resolve(
      typeof window !== 'undefined' ? window.confirm(`${request.title}\n\n${request.message}`) : false,
    );
  }

  // One dialog at a time: a second request while one is open answers the
  // first with "cancel" rather than stacking modals.
  if (snapshot.confirmation) {
    resolveConfirmation(snapshot.confirmation.id, false);
  }

  const id = nextId++;
  return new Promise<boolean>((resolve) => {
    const abort = () => resolveConfirmation(id, false);
    signal?.addEventListener('abort', abort, { once: true });
    confirmationResolvers.set(id, (confirmed) => {
      signal?.removeEventListener('abort', abort);
      resolve(confirmed);
    });
    commit({ ...snapshot, confirmation: { id, request } });
  });
}

export function resolveConfirmation(id: number, confirmed: boolean) {
  const resolver = confirmationResolvers.get(id);
  if (!resolver) {
    return;
  }
  confirmationResolvers.delete(id);
  if (snapshot.confirmation?.id === id) {
    commit({ ...snapshot, confirmation: null });
  }
  resolver(confirmed);
}

/** Test helper: drop every toast and cancel any open confirmation. */
export function resetFeedbackState() {
  for (const [id] of confirmationResolvers) {
    resolveConfirmation(id, false);
  }
  toastDismissHandlers.clear();
  setToastHost(null);
  commit(EMPTY_SNAPSHOT);
}
