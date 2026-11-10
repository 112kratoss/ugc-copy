import { useEffect, useRef } from 'react';

import { useAuth } from './auth';
import { normalizeInviteShareCode } from './invite-share-link/invite-share-link';
import { capturePendingReferral } from './referral-attribution';

/**
 * What to do with the invite a shared link carried, once it is known who is
 * holding the phone:
 *
 * - `wait` while the session is still being read: a signed-in account must
 *   never be taken for a visitor for a moment and recorded;
 * - `skip` for an account that exists, which can never be invited
 *   (`claim_referral_visit` answers `existing_account`), the sharer opening
 *   their own link included, and for a link with no usable invite on it;
 * - `capture` for a visitor or a guest, neither of whom has an account yet.
 */
export function inviteShareCaptureDecision({
  code,
  isAuthLoading,
  hasAccount,
}: {
  code: string | null;
  isAuthLoading: boolean;
  hasAccount: boolean;
}): 'wait' | 'skip' | 'capture' {
  if (!code) return 'skip';
  if (isAuthLoading) return 'wait';
  return hasAccount ? 'skip' : 'capture';
}

/** The first value of a route param, which expo-router may hand over as a list. */
export function inviteShareParam(value: string | string[] | undefined): string | null {
  return normalizeInviteShareCode(Array.isArray(value) ? value[0] : value);
}

/**
 * Records the invite a shared link carried (`?r=<code>`, `lib/invite-share-link/`)
 * when that link opened the app: the post page and the creator page call it
 * with the link's `r` and their own path.
 *
 * It is the invite landing's own capture (`app/r/[code].tsx`) without the
 * landing: the person came to see a post and sees it. The invite is kept on
 * the phone and its visit recorded on the server, so signing up within the
 * program's window claims it (`lib/auth.tsx`), as after an invite link. The
 * first invite a phone holds is the one kept. Once per code, and silently:
 * nothing on the screen waits for it or changes with it.
 */
export function useInviteShareCapture(rawCode: string | string[] | undefined, next: string | null) {
  const { api, user, isLoading } = useAuth();
  const handledRef = useRef<string | null>(null);
  const code = inviteShareParam(rawCode);
  const hasAccount = Boolean(user);

  useEffect(() => {
    if (!next || handledRef.current === code) return;
    const decision = inviteShareCaptureDecision({ code, isAuthLoading: isLoading, hasAccount });
    if (decision === 'wait') return;
    handledRef.current = code;
    if (decision === 'capture' && code) {
      void capturePendingReferral(api, code, { next }).catch(() => undefined);
    }
  }, [api, code, hasAccount, isLoading, next]);
}
