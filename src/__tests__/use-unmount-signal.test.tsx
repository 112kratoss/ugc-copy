import { renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { useUnmountSignal } from '@/lib/use-unmount-signal';

describe('useUnmountSignal', () => {
  it('is live while the component is mounted, and aborted once it unmounts', () => {
    const { result, unmount } = renderHook(() => useUnmountSignal());
    const signal = result.current.current;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
  });

  // Development's Strict Mode mounts, unmounts and mounts again: work started after it must not
  // find the first mount's aborted signal and stop.
  it('ends Strict Mode’s double mount on a live signal', () => {
    const { result, unmount } = renderHook(() => useUnmountSignal(), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    expect(result.current.current.aborted).toBe(false);

    unmount();
    expect(result.current.current.aborted).toBe(true);
  });
});
