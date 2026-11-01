'use client';

import { useEffect, useRef, type RefObject } from 'react';

// Read only before the first mount, when nothing has started that could need it.
const NOT_YET_MOUNTED = new AbortController().signal;

/**
 * The signal of the component's mount, aborted as the component unmounts. Work the component
 * started reads `.current` as it goes (an upload, a request whose answer comes later, a callback
 * answering late) and stops once it is aborted: nothing more is sent, shown or saved for a
 * component that has gone. Each mount has its own, so development's Strict Mode, which mounts
 * twice, ends on a live one.
 */
export function useUnmountSignal(): RefObject<AbortSignal> {
  const signal = useRef(NOT_YET_MOUNTED);
  useEffect(() => {
    const mount = new AbortController();
    signal.current = mount.signal;
    return () => mount.abort();
  }, []);
  return signal;
}
