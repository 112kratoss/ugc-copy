'use client';

import { useEffect, useRef, useState } from 'react';

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
  // What is being asked: an answer to an earlier question is not this field's.
  // The handle alone: once the name passes the form's rules the server's word
  // on a handle cannot change with it (the same `validateProfileUpdate` judges
  // both), so editing the name asks nothing again. The request still carries
  // the name as it stands when it goes out.
  const question = accessToken && shouldCheckHandleAvailability(draft, savedUsername)
    ? draft.username.trim()
    : null;
  const displayNameRef = useRef(draft.displayName.trim());
  useEffect(() => {
    displayNameRef.current = draft.displayName.trim();
  });
  const [answer, setAnswer] = useState<{ question: string; availability: HandleAvailability } | null>(null);

  useEffect(() => {
    if (!question || !accessToken) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const draftNow = { username: question, displayName: displayNameRef.current };
      void checkHandleAvailability(draftNow, accessToken, controller.signal).then((verdict) => {
        if (!controller.signal.aborted) {
          setAnswer({ question, availability: verdict ?? { state: 'idle' } });
        }
      });
    }, HANDLE_CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, question]);

  if (!question) {
    return { state: 'idle' };
  }
  return answer?.question === question ? answer.availability : { state: 'checking' };
}
