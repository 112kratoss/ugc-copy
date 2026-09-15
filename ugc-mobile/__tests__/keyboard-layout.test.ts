import { describe, expect, it } from 'vitest';

import { getKeyboardLift, resolveKeyboardHeight } from '../lib/keyboard';

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
  it('follows the tracker frame by frame while the keyboard is moving', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 180, trackerSettledOpen: false, reportedHeight: 0, reportedHidden: true })).toBe(180);
  });

  // A native Modal taking focus hides the keyboard without an animation, so Android's tracker
  // stays open at the old height and the screen keeps a keyboard-sized hole with no keyboard.
  it('believes a reported hide over a tracker left open without an animation', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 336, trackerSettledOpen: true, reportedHeight: 0, reportedHidden: true })).toBe(0);
  });

  it('closes the hole at the pace of the reported height rather than snapping', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 336, trackerSettledOpen: true, reportedHeight: 140, reportedHidden: true })).toBe(140);
  });

  it('keeps the larger source while both say the keyboard is open', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 336, trackerSettledOpen: true, reportedHeight: 312, reportedHidden: false })).toBe(336);
  });

  it('still gives way to a keyboard the tracker never saw open', () => {
    expect(resolveKeyboardHeight({ trackedHeight: 0, trackerSettledOpen: false, reportedHeight: 312, reportedHidden: false })).toBe(312);
  });
});
