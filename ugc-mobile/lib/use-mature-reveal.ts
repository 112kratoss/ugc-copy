import { useQuery } from '@tanstack/react-query';
import { Platform } from 'react-native';

import { useAuth } from '@/lib/auth';
import { canRevealNsfwInApp, getMatureReveal, type MatureReveal } from '@/lib/nsfw-reveal-policy';

const PREFERENCE_STALE_MS = 5 * 60 * 1000;

/**
 * How this viewer's mature purchases can be shown here (`getMatureReveal`),
 * from their mature-content preference. `needed` is whether anything mature is
 * on screen: only then is the server asked, and a platform that shows no
 * mature media never asks.
 */
export function useMatureReveal(needed: boolean): MatureReveal {
  const { api, user } = useAuth();
  const preference = useQuery({
    queryKey: ['content-preferences', user?.id],
    enabled: needed && Boolean(user) && canRevealNsfwInApp(Platform.OS),
    queryFn: () => api.getContentPreferences(),
    staleTime: PREFERENCE_STALE_MS,
    // Only the website changes it, so coming back to the app is when it may
    // have changed, however recently it was read.
    refetchOnWindowFocus: 'always',
  });
  // A failed refresh keeps what was read; a first read that failed counts as off.
  const showMature = preference.data
    ? preference.data.showMature === true
    : preference.isError ? false : null;
  return getMatureReveal(Platform.OS, showMature);
}
