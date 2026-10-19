import type { ReactNode } from 'react';

/**
 * Elsewhere (Android, tests) the saver notice is drawn in the app's own
 * window. An Android Modal is a window of its own above it, so the bar pauses
 * its countdown while its window has lost the focus instead
 * (`saver-notice-bar.tsx`). The iOS twin is `saver-notice-overlay.ios.tsx`.
 */
export function SaverNoticeOverlay({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
