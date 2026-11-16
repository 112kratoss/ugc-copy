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
 * - `visitor`: no one is signed in, or the check has outlasted SESSION_CHECK_DEADLINE_MS. Drawn and
 *   read as for a visitor, as before the check was waited for, until a late answer names someone.
 * - `signed-in`: the provider has named the viewer (`useAuth().user`).
 */
export type ViewerSessionCheck = 'unread' | 'checking' | 'visitor' | 'signed-in';

/**
 * How long a check is waited for, from when the part waiting on it is drawn in the browser (the
 * hydration, or a client navigation), before the viewer is drawn as a visitor. Supabase's `getUser`,
 * the check's request (`AuthProvider`), has no deadline of its own; answered, it takes about 0.2 s.
 */
export const SESSION_CHECK_DEADLINE_MS = 4_500;

export function useViewerSessionCheck(): ViewerSessionCheck {
  const { user, isLoading } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const hydrated = useHasHydratedSupabaseAuthCookieHint();
  const checking = !user && hydrated && hasAuthCookie && isLoading;
  // Kept once passed: a provider checks a cookie once, when it mounts, so a deadline passed is never
  // another check's (`refreshSessionState` checks again, but no page that waits here calls it).
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    if (!checking) return undefined;
    const deadline = setTimeout(() => setOverdue(true), SESSION_CHECK_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [checking]);

  if (user) return 'signed-in';
  if (!hydrated) return 'unread';
  return checking && !overdue ? 'checking' : 'visitor';
}
