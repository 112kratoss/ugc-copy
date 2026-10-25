import { useEffect, useRef, useState } from 'react';

import type { MagicbookletApiClient } from './api-client';
import {
  normalizeUsername,
  readUsernameRejection,
  shouldCheckUsernameAvailability,
  type UsernameAvailability,
} from './edit-profile-form';

/** How long typing has to pause before the handle is checked, as on Edit profile. */
export const HANDLE_CHECK_DELAY_MS = 400;

export interface HandleAvailabilityState {
  availability: UsernameAvailability;
  /** The server's words for a taken or refused handle. */
  message: string | null;
}

/**
 * The live check Edit profile and onboarding run on a handle, for the
 * name-and-handle card: what the server says about the handle typed, asked
 * once typing pauses, so a taken one shows beside the field instead of only
 * after the press. `shouldCheckUsernameAvailability` decides when a round trip
 * is worth it, and a failed check is no verdict (`readUsernameRejection`): the
 * field goes back to its rule, and the save still judges.
 */
export function useHandleAvailability(
  api: Pick<MagicbookletApiClient, 'validateProfile'>,
  { username, displayName, savedUsername }: { username: string; displayName: string; savedUsername?: string | null },
): HandleAvailabilityState {
  const handle = normalizeUsername(username);
  const name = displayName.trim();
  // What is being asked: an answer to an earlier question is not this field's.
  // The handle alone: the check runs only once the name is there, and the
  // server's word on a handle does not change with the name, so editing the
  // name asks nothing again. The request carries the name as it stands then.
  const question = handle && shouldCheckUsernameAvailability({ value: username, displayName, savedUsername })
    ? handle
    : null;
  const nameRef = useRef(name);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);
  const [answer, setAnswer] = useState<(HandleAvailabilityState & { question: string }) | null>(null);

  useEffect(() => {
    if (!question) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      void api.validateProfile({ username: question, displayName: nameRef.current })
        .then(() => {
          if (current) setAnswer({ question, availability: 'available', message: null });
        })
        .catch((error: unknown) => {
          if (!current) return;
          const rejection = readUsernameRejection(error);
          setAnswer({ question, availability: rejection ? 'taken' : 'idle', message: rejection });
        });
    }, HANDLE_CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, question]);

  if (!question) return { availability: 'idle', message: null };
  return answer?.question === question
    ? { availability: answer.availability, message: answer.message }
    : { availability: 'checking', message: null };
}
