'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';

// Read only before the first mount, when nothing has started that could need it.
const NOT_YET_MOUNTED = new AbortController().signal;

/**
 * The signal of the component's mount, aborted as the component unmounts: in the commit that
 * removes it, before any later work of its can run. Work the component started reads `.current`
 * as it goes (an answer coming back late, a callback of a child) and leaves the page alone once it
 * is aborted. Each mount has its own, so development's Strict Mode, which mounts twice, ends on a
 * live one.
 */
export function useUnmountSignal(): RefObject<AbortSignal> {
  const signal = useRef(NOT_YET_MOUNTED);
  useLayoutEffect(() => {
    const mount = new AbortController();
    signal.current = mount.signal;
    return () => mount.abort();
  }, []);
  return signal;
}
