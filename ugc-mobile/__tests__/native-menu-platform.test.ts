import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ listener: null as ((state: string) => void) | null }));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listener = listener;
      return { remove: () => undefined };
    },
  },
}));

import {
  isNativeMenuShieldRaised,
  lowerNativeMenuShield,
  nativeMenuTouchGuardProps,
  raiseNativeMenuShield,
} from '../lib/native-menu-shield';

const mobileRoot = path.resolve(__dirname, '..');
const read = (relative: string) => readFileSync(path.join(mobileRoot, relative), 'utf8');

describe('the shield over an open native menu', () => {
  beforeEach(() => lowerNativeMenuShield());

  it('lets touches through until a menu opens', () => {
    expect(nativeMenuTouchGuardProps.onStartShouldSetResponderCapture?.({} as never)).toBe(false);
  });

  it('claims the touch that closes the menu, and only that one', () => {
    raiseNativeMenuShield();
    expect(nativeMenuTouchGuardProps.onStartShouldSetResponderCapture?.({} as never)).toBe(true);
    expect(nativeMenuTouchGuardProps.onResponderTerminationRequest?.({} as never)).toBe(false);

    nativeMenuTouchGuardProps.onResponderRelease?.({} as never);
    expect(isNativeMenuShieldRaised()).toBe(false);
    expect(nativeMenuTouchGuardProps.onStartShouldSetResponderCapture?.({} as never)).toBe(false);
  });

  it('comes down when the app leaves the foreground, which closes the menu', () => {
    raiseNativeMenuShield();
    appState.listener?.('background');
    expect(isNativeMenuShieldRaised()).toBe(false);
  });
});

describe('the iOS menu', () => {
  const ios = read('components/native-menu.ios.tsx');

  it('raises the shield when its content appears and lowers it when a row is chosen', () => {
    expect(ios).toContain('modifiers.onAppear(raiseNativeMenuShield)');
    expect(ios).toMatch(/const choose = \(\) => \{\s*lowerNativeMenuShield\(\);\s*action\.onSelect\(\);/);
  });

  it('is guarded at the root, so the closing tap reaches nothing below', () => {
    expect(read('app/_layout.tsx')).toMatch(/<View style=\{\{ flex: 1, backgroundColor: theme\.colors\.app \}\} \{\.\.\.nativeMenuTouchGuardProps\}>/);
  });

  it('draws rows from props, never from child texts that fill in after it opens', () => {
    expect(ios).toContain('label={action.label}');
    expect(ios).not.toMatch(/<Text>\{action\.(label|subtitle)\}<\/Text>/);
  });

  it("keeps the trigger's own colour and size", () => {
    expect(ios).toContain("modifiers.buttonStyle('plain')");
    expect(ios).toMatch(/size=\{trigger\.iconSize\}\s*color=\{trigger\.iconColor\}/);
  });

  it('never evaluates Expo UI in a binary without it', () => {
    expect(ios).toMatch(/if \(!isNativeMenuAvailable\(\) \|\| !hasNativeMenuItems\(props\.model\)\)/);
    expect(ios).not.toMatch(/^import .*'@expo\/ui/m);
    expect(read('components/native-menu.android.tsx')).not.toMatch(/^import .*'@expo\/ui/m);
  });
});

describe('the Android menu', () => {
  const android = read('components/native-menu.android.tsx');
  const surface = read('components/anchored-menu.tsx');

  // The app draws it, so it reaches every build over the air: nothing in it
  // may wait on a native module the way the Material dropdown did.
  it("is the app's own, with no Expo UI and no availability check behind it", () => {
    expect(android).toContain('<AnchoredMenu');
    expect(`${android}\n${surface}`).not.toMatch(/(from|require\()\s*['"]@expo\/ui/);
    expect(android).not.toContain('isNativeMenuAvailable');
  });

  it('is mounted only while it is open or leaving, so a feed of cards pays nothing for it', () => {
    expect(android).toMatch(/\{anchor \? \(\s*<AnchoredMenu/);
  });

  // The press measures this view. Android drops a view that only lays out its
  // children, and a dropped view measures as nothing.
  it('grows from a button it can measure, and opens the sheet when it cannot', () => {
    expect(android).toMatch(/<View ref=\{buttonRef\} collapsable=\{false\}/);
    expect(android.match(/props\.onFallbackPress\(\)/g)?.length).toBe(2);
  });

  // A Modal is another window on Android, above the overlay host: a menu
  // hosted there would open behind the screen that asked for it.
  it('is hosted in the app window, not in a Modal', () => {
    expect(`${android}\n${surface}`).not.toContain('<Modal');
    expect(surface).toMatch(/<Overlay visible>\s*\{\/\*[^]*?\*\/\}\s*<AppSchemeScope>\s*<MenuSurface/);
  });
});
