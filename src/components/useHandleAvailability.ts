'use client';

import { useEffect, useState } from 'react';

import {
  checkHandleAvailability,
  shouldCheckHandleAvailability,
  type PublicIdentityDraft,
} from '@/lib/public-identity';

/** How long typing has to pause before the handle is checked, as on the app's Edit profile. */
export const HANDLE_CHECK_DELAY_MS = 400;

export type HandleAvailability =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'taken'; message: string };

/**
 * The handle field's live check, as Edit profile and onboarding run it on the
 * app: what the server says about the handle typed, asked once typing pauses,
 * so a taken one shows beside the field rather than only after the press.
 * Idle while there is nothing worth asking (`shouldCheckHandleAvailability`)
 * or no token to ask with.
 */
export function useHandleAvailability(
  draft: PublicIdentityDraft,
  { accessToken, savedUsername }: { accessToken?: string | null; savedUsername?: string | null },
): HandleAvailability {
  const username = draft.username.trim();
  const displayName = draft.displayName.trim();
  // What is being asked: an answer to an earlier question is not this field's.
  const question = accessToken && shouldCheckHandleAvailability(draft, savedUsername)
    ? JSON.stringify([username, displayName])
    : null;
  const [answer, setAnswer] = useState<{ question: string; availability: HandleAvailability } | null>(null);

  useEffect(() => {
    if (!question || !accessToken) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void checkHandleAvailability({ username, displayName }, accessToken, controller.signal).then((verdict) => {
        if (!controller.signal.aborted) {
          setAnswer({ question, availability: verdict ?? { state: 'idle' } });
        }
      });
    }, HANDLE_CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, displayName, question, username]);

  if (!question) {
    return { state: 'idle' };
  }
  return answer?.question === question ? answer.availability : { state: 'checking' };
}
