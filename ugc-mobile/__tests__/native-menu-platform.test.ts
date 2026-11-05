import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ listener: null as ((state: string) => void) | null }));
const keyboard = vi.hoisted(() => ({ visible: false }));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listener = listener;
      return { remove: () => undefined };
    },
  },
  Keyboard: { isVisible: () => keyboard.visible },
}));

import {
  isNativeMenuShieldRaised,
  lowerNativeMenuShield,
  NATIVE_MENU_TRIGGER_TAP_SLOP,
  nativeMenuTouchGuardProps,
  nativeMenuTriggerTouchProps,
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

describe('the tap on an iOS menu\'s •••', () => {
  // A card's second opening never raised the shield while it hung on the rows'
  // onAppear, so the tap that closed the menu opened the post (2026-11-05).
  const at = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } }) as never;
  const trigger = nativeMenuTriggerTouchProps;
  /** A touch the ••• owns: no scroll view claimed it first, so it is granted. */
  const press = (from: [number, number], to: [number, number] = from) => {
    trigger.onTouchStart?.(at(...from));
    if (trigger.onStartShouldSetResponder?.(at(...from))) trigger.onResponderGrant?.(at(...from));
    trigger.onTouchEnd?.(at(...to));
  };

  beforeEach(() => {
    lowerNativeMenuShield();
    keyboard.visible = false;
  });

  it('raises the shield on every opening, not only the first', () => {
    press([10, 10]);
    expect(isNativeMenuShieldRaised()).toBe(true);
    nativeMenuTouchGuardProps.onResponderRelease?.({} as never);
    press([10, 10]);
    expect(isNativeMenuShieldRaised()).toBe(true);
  });

  it('counts a finger that settles within the slop as a tap', () => {
    press([10, 10], [10 + NATIVE_MENU_TRIGGER_TAP_SLOP, 10]);
    expect(isNativeMenuShieldRaised()).toBe(true);
  });

  it('leaves it down for a drag that starts on the ••• and opens nothing', () => {
    press([10, 10], [10, 10 + NATIVE_MENU_TRIGGER_TAP_SLOP + 1]);
    expect(isNativeMenuShieldRaised()).toBe(false);
  });

  it('leaves it down for a touch the scroll view takes', () => {
    trigger.onTouchStart?.(at(10, 10));
    trigger.onTouchCancel?.(at(10, 10));
    trigger.onTouchEnd?.(at(10, 10));
    expect(isNativeMenuShieldRaised()).toBe(false);
  });

  it('leaves it down for a drag the scroll view takes over from the •••', () => {
    trigger.onTouchStart?.(at(10, 10));
    trigger.onResponderGrant?.(at(10, 10));
    expect(trigger.onResponderTerminationRequest?.(at(10, 14))).toBe(true);
    trigger.onResponderTerminate?.(at(10, 14));
    trigger.onTouchEnd?.(at(10, 10));
    expect(isNativeMenuShieldRaised()).toBe(false);
  });

  it('leaves it down for a still tap that only stops a fling', () => {
    // The moving scroll view claims the touch in the capture phase, so the
    // ••• is never granted it, and UIKit opens no menu (review of #703).
    trigger.onTouchStart?.(at(10, 10));
    trigger.onTouchEnd?.(at(10, 10));
    expect(isNativeMenuShieldRaised()).toBe(false);
  });

  it('counts a tap a scroll view claims while the keyboard is up, which still opens the menu', () => {
    keyboard.visible = true;
    trigger.onTouchStart?.(at(10, 10));
    trigger.onTouchEnd?.(at(10, 10));
    expect(isNativeMenuShieldRaised()).toBe(true);
  });

  it('leaves it down when the press slides onto a row and the row reaches JS first', () => {
    trigger.onTouchStart?.(at(10, 10));
    trigger.onResponderGrant?.(at(10, 10));
    lowerNativeMenuShield(); // the row's choose()
    trigger.onTouchEnd?.(at(14, 16));
    expect(isNativeMenuShieldRaised()).toBe(false);
  });

  it('does not carry one touch\'s grant into the next', () => {
    press([10, 10]);
    lowerNativeMenuShield();
    trigger.onTouchStart?.(at(10, 10));
    trigger.onTouchEnd?.(at(10, 10));
    expect(isNativeMenuShieldRaised()).toBe(false);
  });

  it('does not raise it again for the tap on the ••• that closes the open menu', () => {
    raiseNativeMenuShield();
    trigger.onTouchStart?.(at(10, 10));
    nativeMenuTouchGuardProps.onResponderRelease?.({} as never);
    trigger.onTouchEnd?.(at(10, 10));
    expect(isNativeMenuShieldRaised()).toBe(false);
  });
});

describe('the iOS menu', () => {
  const ios = read('components/native-menu.ios.tsx');

  it('raises the shield from the tap on its ••• and lowers it when a row is chosen', () => {
    expect(ios).toMatch(/<View style=\{style\} \{\.\.\.nativeMenuTriggerTouchProps\}>\s*<Host\b/);
    // SwiftUI fires a menu's onAppear when it builds the rows, not on each opening.
    expect(ios).not.toContain('modifiers.onAppear(');
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

  it('sits where React Native puts it, wherever in a list it was first laid out', () => {
    // A host laid out below a list's fold kept the home indicator's inset and
    // drew its ••• 17 pt above the row once scrolled up (2026-11-03).
    expect(ios).toMatch(/<Host\b[^>]*ignoreSafeArea="all"/);
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
