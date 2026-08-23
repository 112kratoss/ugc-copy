import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

/**
 * Claim Android's back key while `enabled`, running `handler` instead of the
 * navigator's pop.
 *
 * Listeners are consulted newest-first and stay registered under screens
 * pushed on top, so callers gate `enabled` on the screen being focused as
 * well as on the state they want to unwind — otherwise a viewer two screens
 * down swallows the back key for the profile above it. A visible `Modal`
 * takes the key natively before any listener runs, which is the right order:
 * back closes the sheet first, then the page behind it.
 *
 * The latest `handler` is always the one that runs; re-rendering with a new
 * closure does not re-subscribe.
 */
export function useHardwareBack(enabled: boolean, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    // The react-native test mock has no BackHandler; iOS has one that never fires.
    if (!enabled || typeof BackHandler?.addEventListener !== 'function') return;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handlerRef.current();
      return true;
    });

    return () => subscription.remove();
  }, [enabled]);
}
