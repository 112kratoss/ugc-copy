import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * The community rules a person accepts before they first create or post.
 *
 * Google Play's user-generated content policy asks that people accept an app's
 * terms before they can create or upload anything others will see. After the
 * September 2026 policy notice the owner chose to state the rules up front
 * rather than filter more prompts, so `ContentPolicyGate` shows them the first
 * time a creation screen opens: the Create tab, a creation tool, a template, or
 * the post composer. The full wording is the Terms of Service at /terms.
 *
 * Held per phone, like the AI data-sharing answer (`lib/ai-data-consent.ts`),
 * so guests are asked too, in one process-wide store read at launch.
 */

/**
 * Raise when the rules change materially. A stored answer for another version
 * is ignored, so everyone sees the new rules before they next create.
 */
export const CONTENT_POLICY_VERSION = 1;

export const CONTENT_POLICY_STORAGE_KEY = 'magicbooklet.content-policy.v1';

export const CONTENT_POLICY_TITLE = 'Before you create.';

export const CONTENT_POLICY_INTRO =
  'Magicbooklet is for people 13 and older. Everything you make and share has to follow these rules.';

// Each line restates a rule in the Terms of Service (section 6, Acceptable Use).
export const CONTENT_POLICY_RULES = [
  'No sexual content involving anyone under 18. Ever.',
  'No nude or sexual images of a real person without their consent, including AI edits of their photos.',
  'Nudity only in posts you mark mature. They stay hidden until an adult chooses to see them.',
  'No real-world graphic violence or gore.',
  'No hate, harassment or threats, and nothing that encourages self-harm.',
  'Don’t pass off other people’s work or identity as your own.',
] as const;

export const CONTENT_POLICY_ENFORCEMENT =
  'Posts, comments, people and AI results can be reported from their menus. Breaking these rules can get content removed or an account banned.';

export const CONTENT_POLICY_ACCEPTANCE = 'By tapping I agree, you accept these rules and the Terms of Service.';

type StoredContentPolicyAcceptance = { version: number; acceptedAt: string };

export type ContentPolicySnapshot = {
  /** False until the stored answer has been read, so a screen can wait rather than flash the rules. */
  hydrated: boolean;
  /** When the rules were accepted on this phone, or null when they have not been. */
  acceptedAt: string | null;
};

export function parseStoredContentPolicyAcceptance(raw: string | null): StoredContentPolicyAcceptance | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredContentPolicyAcceptance> | null;
    if (value?.version !== CONTENT_POLICY_VERSION) return null;
    if (typeof value.acceptedAt !== 'string' || Number.isNaN(Date.parse(value.acceptedAt))) return null;
    return { version: value.version, acceptedAt: value.acceptedAt };
  } catch {
    return null;
  }
}

let snapshot: ContentPolicySnapshot = { hydrated: false, acceptedAt: null };
let hydration: Promise<void> | null = null;
// Counts acceptances in this process, so a slow first read cannot overwrite one.
let answers = 0;
const listeners = new Set<() => void>();

function publish(next: ContentPolicySnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Reads the stored answer once. A failed read counts as not accepted, so the rules are shown. */
export function hydrateContentPolicy() {
  if (hydration) return hydration;
  const answersBefore = answers;
  hydration = AsyncStorage.getItem(CONTENT_POLICY_STORAGE_KEY)
    .then((raw) => parseStoredContentPolicyAcceptance(raw))
    .catch(() => null)
    .then((stored) => {
      if (answers !== answersBefore) {
        publish({ ...snapshot, hydrated: true });
        return;
      }
      publish({ hydrated: true, acceptedAt: stored?.acceptedAt ?? null });
    });
  return hydration;
}

export function getContentPolicySnapshot() {
  return snapshot;
}

/**
 * Takes effect at once. A failed write keeps the acceptance for this session,
 * and the next launch shows the rules again: that errs toward showing them.
 */
export function acceptContentPolicy(now: Date = new Date()) {
  answers += 1;
  const acceptedAt = now.toISOString();
  publish({ hydrated: true, acceptedAt });
  const stored: StoredContentPolicyAcceptance = { version: CONTENT_POLICY_VERSION, acceptedAt };
  return AsyncStorage.setItem(CONTENT_POLICY_STORAGE_KEY, JSON.stringify(stored)).catch(() => undefined);
}

export function subscribeContentPolicy(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useContentPolicy(): ContentPolicySnapshot {
  useEffect(() => {
    void hydrateContentPolicy();
  }, []);
  return useSyncExternalStore(subscribeContentPolicy, getContentPolicySnapshot, getContentPolicySnapshot);
}

/** Test seam: the module holds process state, so a suite has to be able to reset it. */
export function resetContentPolicyForTests() {
  listeners.clear();
  snapshot = { hydrated: false, acceptedAt: null };
  hydration = null;
  answers = 0;
}
