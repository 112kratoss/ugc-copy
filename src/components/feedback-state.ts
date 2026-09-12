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

/** The server and first client render must agree: nothing is showing. */
export function readServerFeedbackSnapshot(): FeedbackSnapshot {
  return EMPTY_SNAPSHOT;
}

export function pushToast(toast: { tone: ToastTone; message: string; durationMs?: number }): number {
  const id = nextId++;
  commit({
    ...snapshot,
    toasts: [
      ...snapshot.toasts,
      {
        id,
        tone: toast.tone,
        message: toast.message,
        durationMs: toast.durationMs ?? DEFAULT_TOAST_DURATION_MS,
      },
    ],
  });
  return id;
}

export function dismissToast(id: number) {
  if (!snapshot.toasts.some((toast) => toast.id === id)) {
    return;
  }
  commit({ ...snapshot, toasts: snapshot.toasts.filter((toast) => toast.id !== id) });
}

/**
 * Ask the viewer to confirm. Resolves with their answer once `FeedbackViewport`
 * has shown the dialog and they have chosen. With no viewport mounted (a test
 * rendering a single component, for instance) it falls back to the native
 * dialog so the caller still gets an answer instead of hanging.
 */
export function requestConfirmation(request: ConfirmationRequest): Promise<boolean> {
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
    confirmationResolvers.set(id, resolve);
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
  commit(EMPTY_SNAPSHOT);
}
