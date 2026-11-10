import { useCallback, useState } from 'react';

import type { AuthNotice } from './auth-error-copy';

/**
 * The notice a sign-in page shows above its ways in (`components/sign-in-wall.tsx` and its
 * email half): the route's own (why a redirect sent the person here, or the invite a shared
 * link left on the phone, `app/auth.tsx`) until the page says something itself (a failed
 * sign-in, or nothing once one begins), then the page's.
 *
 * The route's is read as it comes, not kept from the first frame: the invite's is read from
 * the phone's store just after the page is drawn, and a copy taken then never showed it
 * (seen on the simulator, 2026-11-10).
 */
export function useSignInPageNotice(routeNotice: AuthNotice | null) {
  const [own, setOwn] = useState<{ notice: AuthNotice | null } | null>(null);
  const setNotice = useCallback((notice: AuthNotice | null) => setOwn({ notice }), []);
  return [own ? own.notice : routeNotice, setNotice] as const;
}
