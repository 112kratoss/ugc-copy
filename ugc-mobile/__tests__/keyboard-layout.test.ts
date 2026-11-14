import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getKeyboardLift,
  isTrackerMotion,
  listenToReportedKeyboard,
  type ReportedKeyboardApi,
  type ReportedKeyboardEvent,
  resolveKeyboardHeight,
} from '../lib/keyboard';

describe('keyboard lift', () => {
  it('gives way by nothing while the keyboard is closed', () => {
    expect(getKeyboardLift({ keyboardHeight: 0, reservedBottomInset: 34 })).toBe(0);
  });

  it('gives way by the full keyboard when no inset is already reserved', () => {
    expect(getKeyboardLift({ keyboardHeight: 320 })).toBe(320);
  });

  it('discounts an inset the surface already clears so it does not overshoot', () => {
    expect(getKeyboardLift({ keyboardHeight: 336, reservedBottomInset: 34 })).toBe(302);
  });

  it('never travels backwards when the reserved inset exceeds the keyboard', () => {
    expect(getKeyboardLift({ keyboardHeight: 20, reservedBottomInset: 34 })).toBe(0);
  });

  it('treats a NaN height as closed rather than poisoning the layout', () => {
    expect(getKeyboardLift({ keyboardHeight: Number.NaN, reservedBottomInset: 24 })).toBe(0);
  });
});

// Heights are the Pixel 9a emulator's: the tracker counts the navigation bar, the events do not.
describe('keyboard height resolution', () => {
  // The caller drops a reported hide the moment the tracker's height moves, so
  // while the keys travel the tracker's frame is what the surface follows.
  it('follows the tracker frame by frame while the keyboard is moving', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 180, reportedHeight: 0, reportedHidden: false })).toBe(180);
  });

  // A native Modal taking focus hides the keyboard without an animation, so Android's tracker
  // keeps the old height and the screen keeps a keyboard-sized hole with no keyboard.
  it('believes a reported hide over a tracker left at its old height', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 336, reportedHeight: 0, reportedHidden: true })).toBe(0);
  });

  it('closes the hole at the pace of the reported height rather than snapping', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 336, reportedHeight: 140, reportedHidden: true })).toBe(140);
  });

  it('keeps the larger source while both say the keyboard is open', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 336, reportedHeight: 312, reportedHidden: false })).toBe(336);
  });

  it('still gives way to a keyboard the tracker never saw open', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 0, reportedHeight: 312, reportedHidden: false })).toBe(312);
  });

  it('never waits for the tracker to settle', () => {
    // Reanimated settles its state (OPEN, CLOSED) by counting the starts and
    // ends of keyboard animations, and stops listening when its last
    // subscriber unmounts. A sheet that closes with the keyboard up unmounts
    // its area before the keys have gone: the end is never counted and the
    // state reads OPENING or CLOSING from then on, with the keyboard standing
    // still. The rule once waited for a tracker "settled open" before it
    // believed a hide, and after that it never did: under the "Discard
    // resource changes?" dialog the editor stayed shortened over an empty
    // band (Pixel 9a emulator, 2026-10-05). Whether the tracker has moved is
    // read from its height, and only the in-flight states are ever asked
    // about, which an unsettled counter leaves the tracker in for good.
    const source = readFileSync(path.resolve(__dirname, '../components/keyboard-aware.tsx'), 'utf8');
    expect(source).toContain('keyboard.height.value');
    expect(source).not.toMatch(/KeyboardState\.(OPEN|CLOSED|UNKNOWN)\b/);
  });
});

// Reanimated reports a keyboard animation's frames with the keyboard OPENING
// or CLOSING. It also tells its last height again, as OPEN, whenever the
// window's insets are applied while it believes the keyboard is up: as an area
// subscribes after none was listening, and as the app comes back to the front.
describe('tracker motion', () => {
  it('counts a height change in an animation frame as the keyboard moving', () => {
    expect(isTrackerMotion({ height: 180, previousHeight: 0, animating: true })).toBe(true);
    expect(isTrackerMotion({ height: 120, previousHeight: 336, animating: true })).toBe(true);
  });

  // The search screen closed with its keyboard up took the only area away before
  // the keys had gone, so the tracker never saw them leave. The sign-in wall
  // opened next was told "open, 336" as it subscribed and drew a keyboard-sized
  // band with no keyboard (Pixel 9a emulator; the owner's S24 on Withdraw, 2026-11-14).
  it('does not count an old height told again outside an animation', () => {
    expect(isTrackerMotion({ height: 336, previousHeight: 0, animating: false })).toBe(false);
  });

  it('does not count a frame that leaves the height where it was', () => {
    expect(isTrackerMotion({ height: 336, previousHeight: 336, animating: true })).toBe(false);
  });

  it('does not count the first value an area hears', () => {
    expect(isTrackerMotion({ height: 336, previousHeight: null, animating: true })).toBe(false);
  });
});

describe('reported keyboard events', () => {
  function fakeKeyboard(visible?: boolean) {
    const listeners = new Map<string, (event: ReportedKeyboardEvent) => void>();
    const removed: string[] = [];
    const keyboard: ReportedKeyboardApi = {
      addListener: (name, listener) => {
        listeners.set(name, listener);
        return { remove: () => removed.push(name) };
      },
      ...(visible === undefined ? {} : { isVisible: () => visible }),
    };
    return { keyboard, listeners, removed };
  }

  function listen(visible: boolean | undefined, ios: boolean) {
    const fake = fakeKeyboard(visible);
    const heard: string[] = [];
    const stop = listenToReportedKeyboard({
      keyboard: fake.keyboard,
      ios,
      onShow: (event) => heard.push(`show ${event.endCoordinates.height}`),
      onHide: (event) => heard.push(event ? 'hide' : 'found down'),
    });
    return { ...fake, heard, stop };
  }

  it('hears Android by its did events alone', () => {
    expect([...listen(true, false).listeners.keys()]).toEqual(['keyboardDidShow', 'keyboardDidHide']);
  });

  it('hears iOS by its will events and its did events', () => {
    expect([...listen(true, true).listeners.keys()].sort()).toEqual(
      ['keyboardDidHide', 'keyboardDidShow', 'keyboardWillHide', 'keyboardWillShow'],
    );
  });

  // A surface mounted between iOS's willShow and didShow reads "down" from
  // `isVisible()` and has missed the will event; the did event still lifts it.
  it('still hears an iOS keyboard whose will event went by before it listened', () => {
    const { listeners, heard } = listen(false, true);
    listeners.get('keyboardDidShow')!({ endCoordinates: { height: 336 } });
    expect(heard).toEqual(['found down', 'show 336']);
  });

  // `isVisible()` is read at render and the listeners start after it: a hide
  // landing between the two would otherwise never reach the surface.
  it('reports a keyboard already counted down once it starts listening', () => {
    expect(listen(false, false).heard).toEqual(['found down']);
    expect(listen(true, false).heard).toEqual([]);
    expect(listen(undefined, false).heard).toEqual([]);
  });

  it('stops hearing every event it started hearing', () => {
    const { listeners, removed, stop } = listen(true, true);
    stop();
    expect(removed.sort()).toEqual([...listeners.keys()].sort());
  });
});
