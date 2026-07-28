'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { supabase } from '@/lib/supabase';

/**
 * Mounted only on the stale-cookie branch of the home dashboard: the
 * middleware saw an auth cookie, but the server could not verify a session.
 * Two ways this resolves, both without navigation:
 *
 * - The browser SDK still holds a refreshable session → refresh succeeds →
 *   `router.refresh()` re-renders the RSC tree as the dashboard.
 * - The cookie is genuinely dead → the SDK's failed refresh clears it, so the
 *   next request to `/` skips the middleware rewrite and gets the static
 *   marketing page.
 */
export default function StaleSessionRecovery() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && data.session) {
        router.refresh();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
