'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * `window.matchMedia` as a store. The server snapshot is `false`, so a
 * component that renders either way must not let the first client render
 * depend on it (the home workspace card only gates a timer on it).
 */
export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback((onChange: () => void) => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
        const list = window.matchMedia(query);
        list.addEventListener?.('change', onChange);
        return () => list.removeEventListener?.('change', onChange);
    }, [query]);
    const getSnapshot = useCallback(
        () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
        [query],
    );
    return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
