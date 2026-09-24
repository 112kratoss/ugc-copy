import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import { showConfirmDialog } from '@/lib/dialog';

/**
 * Permission to send a person's prompts and media to the AI services that make
 * their images and videos.
 *
 * Nothing leaves the phone for an AI service before this is given. App Review
 * rejected 0.1.6 (55) under guidelines 5.1.1(i) and 5.1.2(i): an app that sends
 * personal data to a third-party AI service has to say what it sends, name who
 * receives it, and ask first. Every path that does so passes
 * `ensureAiDataConsent`: generating and enhancing a prompt on the create screen,
 * and starting, retrying or approving a template run.
 *
 * Held per phone, like the Appearance choice (`lib/appearance.ts`), in one
 * process-wide store: the create screen asks, and Settings → AI data sharing
 * shows and changes the same answer.
 */

/**
 * Raise when what is sent, or who receives it, changes materially. A stored
 * answer from another version is ignored, so everyone is asked again.
 */
export const AI_DATA_CONSENT_VERSION = 1;

export const AI_DATA_CONSENT_STORAGE_KEY = 'magicbooklet.ai-data-consent.v1';

/**
 * The companies whose models the app can send a request to, through Kie.ai. The
 * prompt enhancer is Google's Gemini. `src/__tests__/ai-data-recipients.test.ts`
 * fails when a model in `src/lib/models.ts` has a maker missing from this list.
 */
export const AI_MODEL_MAKERS = [
  'Google',
  'OpenAI',
  'ByteDance',
  'Kuaishou',
  'Alibaba',
  'MiniMax',
  'xAI',
  'Ideogram',
  'Black Forest Labs',
] as const;

export function formatAiModelMakers(conjunction: 'or' | 'and' = 'or') {
  return `${AI_MODEL_MAKERS.slice(0, -1).join(', ')} ${conjunction} ${AI_MODEL_MAKERS[AI_MODEL_MAKERS.length - 1]}`;
}

export const AI_DATA_CONSENT_TITLE = 'Share your prompts and media with AI services?';

// What is sent, who receives it, why, and what never goes: the four things
// 5.1.2(i) asks an app to say before it sends anything.
export const AI_DATA_CONSENT_MESSAGE =
  'To create, Magicbooklet sends your prompt and any photos, videos or audio you add to Kie.ai, '
  + 'which runs our AI models, and to the company that made the model: '
  + `${formatAiModelMakers('or')}. `
  + 'It’s sent only to make your result, and never with your name or email. '
  + 'You can change this in Settings → AI data sharing.';

/**
 * The same facts at more length, for Settings → AI data sharing. All of the
 * app's wording that names these companies lives in this file, the one the
 * provider-name guard in `__tests__/backend-boundary.test.ts` lets through.
 */
export const AI_DATA_SHARED_ITEMS =
  'Your prompt, and any photos, videos or audio you add. Only when you generate, enhance a prompt or start a template.';

export const AI_DATA_RECIPIENTS =
  'Kie.ai, which runs our AI models, and the company that made the model you choose: '
  + `${formatAiModelMakers('or')}. Enhance prompt uses Google’s Gemini.`;

export const AI_DATA_USE =
  'Only to make the result you asked for. Your name, email and payment details are never sent.';

type StoredAiDataConsent = { version: number; grantedAt: string };

export type AiDataConsentSnapshot = {
  /** False until the stored answer has been read, so a screen can wait rather than flash "not allowed". */
  hydrated: boolean;
  /** When permission was given on this phone, or null when it has not been. */
  grantedAt: string | null;
};

export function parseStoredAiDataConsent(raw: string | null): StoredAiDataConsent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredAiDataConsent> | null;
    if (value?.version !== AI_DATA_CONSENT_VERSION) return null;
    if (typeof value.grantedAt !== 'string' || Number.isNaN(Date.parse(value.grantedAt))) return null;
    return { version: value.version, grantedAt: value.grantedAt };
  } catch {
    return null;
  }
}

let snapshot: AiDataConsentSnapshot = { hydrated: false, grantedAt: null };
let hydration: Promise<void> | null = null;
let pendingRequest: Promise<boolean> | null = null;
// Counts answers given in this process, so a slow first read cannot overwrite one.
let answers = 0;
const listeners = new Set<() => void>();

function publish(next: AiDataConsentSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Reads the stored answer once. A failed read counts as no permission, so the person is asked. */
export function hydrateAiDataConsent() {
  if (hydration) return hydration;
  const answersBefore = answers;
  hydration = AsyncStorage.getItem(AI_DATA_CONSENT_STORAGE_KEY)
    .then((raw) => parseStoredAiDataConsent(raw))
    .catch(() => null)
    .then((stored) => {
      if (answers !== answersBefore) {
        publish({ ...snapshot, hydrated: true });
        return;
      }
      publish({ hydrated: true, grantedAt: stored?.grantedAt ?? null });
    });
  return hydration;
}

/** "25 Sep 2026", in the phone's own order. An unreadable value gives nothing rather than "Invalid Date". */
export function formatAiDataConsentDate(grantedAt: string) {
  const parsed = new Date(grantedAt);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function getAiDataConsentSnapshot() {
  return snapshot;
}

export function hasAiDataConsent() {
  return snapshot.grantedAt !== null;
}

/**
 * Takes effect at once. A failed write keeps the permission for this session,
 * and the next launch asks again: that errs toward asking.
 */
export function grantAiDataConsent(now: Date = new Date()) {
  answers += 1;
  const grantedAt = now.toISOString();
  publish({ hydrated: true, grantedAt });
  const stored: StoredAiDataConsent = { version: AI_DATA_CONSENT_VERSION, grantedAt };
  return AsyncStorage.setItem(AI_DATA_CONSENT_STORAGE_KEY, JSON.stringify(stored)).catch(() => undefined);
}

/** Nothing more is sent until permission is given again, when the next request asks. */
export function withdrawAiDataConsent() {
  answers += 1;
  publish({ hydrated: true, grantedAt: null });
  return AsyncStorage.removeItem(AI_DATA_CONSENT_STORAGE_KEY).catch(() => undefined);
}

/**
 * The gate in front of every request that sends a prompt or media to an AI
 * service. Resolves true when permission was already given, or is given now;
 * anything else resolves false, and the caller sends nothing.
 *
 * Asked with the app's own dialog: the system alert on iOS, which shows over
 * the modal screens the create flow lives in. The buttons are the pair iOS uses
 * for its own permission requests. "Cancel" would read as cancelling the
 * generation, not as declining to share.
 *
 * A call made while the question is still open resolves false, and only the
 * call that asked goes ahead on Allow. A double tap on Generate can land before
 * the dialog is up, and the two taps must not start two runs. Once permission
 * is stored, every step here settles in microtasks, before the next touch is
 * handled, so a caller's own in-flight guard still sees the second tap.
 */
export function ensureAiDataConsent(): Promise<boolean> {
  if (pendingRequest) return Promise.resolve(false);
  const request = (async () => {
    await hydrateAiDataConsent();
    if (hasAiDataConsent()) return true;
    const allowed = await showConfirmDialog({
      title: AI_DATA_CONSENT_TITLE,
      message: AI_DATA_CONSENT_MESSAGE,
      confirmLabel: 'Allow',
      cancelLabel: 'Don’t Allow',
    });
    if (allowed) await grantAiDataConsent();
    return allowed;
  })();
  pendingRequest = request;
  void request.finally(() => {
    if (pendingRequest === request) pendingRequest = null;
  }).catch(() => undefined);
  return request;
}

/** Runs `send` only once permission is in hand. */
export async function withAiDataConsent(send: () => void) {
  if (await ensureAiDataConsent()) send();
}

export function subscribeAiDataConsent(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAiDataConsent(): AiDataConsentSnapshot {
  useEffect(() => {
    void hydrateAiDataConsent();
  }, []);
  return useSyncExternalStore(subscribeAiDataConsent, getAiDataConsentSnapshot, getAiDataConsentSnapshot);
}

/** Test seam: the module holds process state, so a suite has to be able to reset it. */
export function resetAiDataConsentForTests() {
  listeners.clear();
  snapshot = { hydrated: false, grantedAt: null };
  hydration = null;
  pendingRequest = null;
  answers = 0;
}
