import type { ReactNode } from 'react';

import { useResolvedColorScheme } from '@/lib/appearance';
import { ThemeScope } from '@/lib/theme-context';

/**
 * Hands a subtree back to the app's own scheme from inside a fixed one. The
 * reel stays dark over video in both schemes, but a sheet it opens — actions,
 * comments, an unlock — is app UI rather than media chrome, and follows the
 * app, as it does in the other large feeds.
 */
export function AppSchemeScope({ children }: { children: ReactNode }) {
  return <ThemeScope scheme={useResolvedColorScheme()}>{children}</ThemeScope>;
}
