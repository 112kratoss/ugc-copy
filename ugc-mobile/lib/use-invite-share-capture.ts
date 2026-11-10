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

/** Waits before the second, third and fourth try of a capture that failed. */
export const INVITE_SHARE_CAPTURE_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;

/**
 * Captures made in this run, by code, with every screen still waiting on each.
 * One code is captured once per run however many screens ask: the legacy-id
 * resolver re-opens the post page with the same link, and two screens at once
 * each posted a visit (review of 2026-11-10). It keeps trying while any of
 * those screens is open, not only the first, which the resolver unmounts
 * (re-review of 2026-11-10). A capture that fails leaves the map, so it can be
 * tried again.
 */
const captures = new Map<string, { attempt: Promise<boolean>; waiting: Set<() => boolean> }>();

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Captures `code` from a shared link, trying again after a failure while
 * `isCurrent` says the screen still wants it. Resolves true once the visit is
 * recorded.
 */
export function captureInviteFromSharedLink(
  api: Parameters<typeof capturePendingReferral>[0],
  code: string,
  next: string,
  isCurrent: () => boolean = () => true,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<boolean> {
  const existing = captures.get(code);
  if (existing) {
    existing.waiting.add(isCurrent);
    return existing.attempt;
  }

  const waiting = new Set<() => boolean>([isCurrent]);
  const anyoneWaiting = () => [...waiting].some((current) => current());
  const attempt = (async () => {
    for (let index = 0; index <= INVITE_SHARE_CAPTURE_RETRY_DELAYS_MS.length; index += 1) {
      if (index > 0) {
        await sleep(INVITE_SHARE_CAPTURE_RETRY_DELAYS_MS[index - 1]!);
        if (!anyoneWaiting()) break;
      }
      try {
        await capturePendingReferral(api, code, { next, kind: 'shared_link' });
        return true;
      } catch {
        // Offline, or the server busy: the code is saved on the phone either
        // way, and the next try (here, or when the app comes back) records it.
      }
    }
    captures.delete(code);
    return false;
  })();
  captures.set(code, { attempt, waiting });
  return attempt;
}

/** For tests: a fresh app run. */
export function resetInviteShareCapturesForTests(): void {
  captures.clear();
}

/**
 * Records the invite a shared link carried (`?r=<code>`, `lib/invite-share-link/`)
 * when that link opened the app: the post page and the creator page call it
 * with the link's `r` and their own path.
 *
 * It is the invite landing's own capture (`app/r/[code].tsx`) without the
 * landing: the person came to see a post and sees it. The invite is kept on
 * the phone and its visit recorded on the server, so signing up within the
 * program's window claims it (`lib/auth.tsx`), as after an invite link. An
 * invite link opened later replaces it; it replaces nothing. Once per code,
 * and silently: nothing on the screen waits for it or changes with it.
 */
export function useInviteShareCapture(rawCode: string | string[] | undefined, next: string | null) {
  const { api, user, isLoading } = useAuth();
  const handledRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const code = inviteShareParam(rawCode);
  const hasAccount = Boolean(user);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!next || handledRef.current === code) return;
    const decision = inviteShareCaptureDecision({ code, isAuthLoading: isLoading, hasAccount });
    if (decision === 'wait') return;
    handledRef.current = code;
    if (decision === 'capture' && code) {
      void captureInviteFromSharedLink(api, code, next, () => mountedRef.current);
    }
  }, [api, code, hasAccount, isLoading, next]);
}
