import { useEffect, useRef } from 'react';
import * as ReactNative from 'react-native';

/**
 * Focused component tests mock react-native down to the exports they render,
 * and reading a missing one off the mock namespace throws rather than yielding
 * undefined — so the read is guarded, same as `lib/motion`.
 */
function optionalNativeExport<T>(read: () => T) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const backHandlerApi = optionalNativeExport(() => ReactNative.BackHandler);

/**
 * Claim Android's back key while `enabled`, running `handler` instead of the
 * navigator's pop.
 *
 * Listeners are consulted newest-first and stay registered under screens
 * pushed on top, so callers gate `enabled` on the screen being focused as
 * well as on the state they want to unwind — otherwise a viewer two screens
 * down swallows the back key for the profile above it.
 *
 * Surfaces rendered through `OverlayHost` rather than a `Modal` must claim the
 * key here: a Modal used to take it natively before any listener ran, and an
 * overlay is an ordinary view with no such privilege.
 *
 * The latest `handler` is always the one that runs; re-rendering with a new
 * closure does not re-subscribe.
 */
export function useHardwareBack(enabled: boolean, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    // iOS has a BackHandler that never fires; tests may have none at all.
    if (!enabled || typeof backHandlerApi?.addEventListener !== 'function') return;

    const subscription = backHandlerApi.addEventListener('hardwareBackPress', () => {
      handlerRef.current();
      return true;
    });

    return () => subscription.remove();
  }, [enabled]);
}
