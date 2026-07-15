'use client';

import { useSyncExternalStore } from 'react';

import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

function subscribeToAuthCookieChanges(onStoreChange: () => void) {
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      onStoreChange();
    }
  };

  window.addEventListener('focus', onStoreChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  return () => {
    window.removeEventListener('focus', onStoreChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

const getServerAuthCookieSnapshot = () => false;
const subscribeToHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;

export function useSupabaseAuthCookieHint() {
  return useSyncExternalStore(
    subscribeToAuthCookieChanges,
    hasSupabaseAuthCookie,
    getServerAuthCookieSnapshot
  );
}

export function useHasHydratedSupabaseAuthCookieHint() {
  return useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerAuthCookieSnapshot
  );
}
