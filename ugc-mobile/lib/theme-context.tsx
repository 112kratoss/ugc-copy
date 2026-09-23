import { createContext, useContext, type ReactNode } from 'react';

import { themes, type AppTheme, type ColorScheme } from '@/lib/theme';

/**
 * The theme a component draws with. Outside any provider — a focused test
 * rendering one component — it is the dark theme, the look every screen had
 * before light mode existed.
 */
const ThemeContext = createContext<AppTheme>(themes.dark);

/**
 * Draws its subtree in one scheme. The root layout wraps the whole app in the
 * scheme the phone (or Settings → Appearance) resolved; a surface that must
 * keep its own look — the reel, which stays dark over video in both schemes —
 * wraps itself in a fixed one.
 */
export function ThemeScope({ scheme, children }: { scheme: ColorScheme; children: ReactNode }) {
  return <ThemeContext.Provider value={themes[scheme]}>{children}</ThemeContext.Provider>;
}

/**
 * Colours, semantic tones, state and shadows for the scheme in force here.
 * Read it at the top of a component and take colours from it rather than
 * from `appTheme`: a module constant is memoised once for the life of the
 * process, so only a context value lets React Compiler redraw on a switch.
 * Scheme-independent tokens (spacing, radii, type, motion) stay on `appTheme`.
 */
export function useAppTheme(): AppTheme {
  return useContext(ThemeContext);
}
