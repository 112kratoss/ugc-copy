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
