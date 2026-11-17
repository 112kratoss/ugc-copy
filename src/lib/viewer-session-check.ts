'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/components/AuthProvider';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';

/**
 * Who is looking, as a page that checks the session in the browser knows it at this render. The
 * post page and the reels have a provider of their own on each page (`OptionalAuth`), a client
 * navigation included, and it asks Supabase before it names anyone: until then a signed-in reader
 * was drawn as a visitor, with "Sign in to join the conversation" in their composer's place and a
 * "Report user · Block user" row that came in late and pushed Comments down (owner's recording,
 * 2026-11-16).
 *
 * - `unread`: the server's HTML and the render that hydrates it, where no cookie can be read. What
 *   only one kind of viewer gets is drawn both ways there, and the root element's marks, set from
 *   the session cookie before the first paint (`app-shell-account-restore.ts`), show one.
 * - `checking`: the browser holds a session cookie the provider is still checking. Drawn as for a
 *   signed-in viewer, and what depends on who they are is not read yet.
 * - `visitor`: no one is signed in, or the check has outlasted its deadline (SESSION_CHECK_DEADLINE_MS
 *   from when it began, SESSION_CHECK_START_DEADLINE_MS for one that has not). Drawn and read as for
 *   a visitor, as before the check was waited for, until a late answer names someone. What only a
 *   post's own creator gets on it does not fall back here: it waits for the check's answer
 *   (`ShowcasePostOwnership` in useShowcasePostViewer).
 * - `signed-in`: the provider has named the viewer (`useAuth().user`).
 */
export type ViewerSessionCheck = 'unread' | 'checking' | 'visitor' | 'signed-in';

/**
 * How long a check is waited for, from when the provider began it (`sessionCheckStartedAt`: a token
 * refresh and Supabase's `getUser`, neither with a deadline of its own), before the viewer is drawn
 * as a visitor. Answered, a check takes about 0.2 s, two round trips with a refresh.
 */
export const SESSION_CHECK_DEADLINE_MS = 4_500;

/**
 * How long a check that has not begun is waited for, from when the part waiting on it is drawn in
 * the browser (the hydration, or a client navigation): supabase-js still loading, which on a slow
 * phone takes seconds of its own, or a chunk that never comes.
 */
export const SESSION_CHECK_START_DEADLINE_MS = 8_000;

export function useViewerSessionCheck(): ViewerSessionCheck {
  const { user, isLoading, sessionCheckStartedAt } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const hydrated = useHasHydratedSupabaseAuthCookieHint();
  const checking = !user && hydrated && hasAuthCookie && isLoading;
  // Kept once passed: a provider checks a cookie once, when it mounts, so a deadline passed is never
  // another check's (`refreshSessionState` checks again, but no page that waits here calls it).
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    if (!checking) return undefined;
    // Once the check has begun, every part waiting on it falls back at the same moment, one drawn
    // late (a reel's thread opened during it) included.
    const wait = typeof sessionCheckStartedAt === 'number'
      ? Math.max(0, sessionCheckStartedAt + SESSION_CHECK_DEADLINE_MS - performance.now())
      : SESSION_CHECK_START_DEADLINE_MS;
    const deadline = setTimeout(() => setOverdue(true), wait);
    return () => clearTimeout(deadline);
  }, [checking, sessionCheckStartedAt]);

  if (user) return 'signed-in';
  if (!hydrated) return 'unread';
  return checking && !overdue ? 'checking' : 'visitor';
}
