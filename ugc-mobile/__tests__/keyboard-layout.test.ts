import { readFileSync } from 'node:fs';
import path from 'node:path';

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

  it('never asks the tracker what state it is in', () => {
    // Reanimated settles its state (OPEN, CLOSED) by counting the starts and
    // ends of keyboard animations, and stops listening when its last
    // subscriber unmounts. A sheet that closes with the keyboard up unmounts
    // its area before the keys have gone: the end is never counted and the
    // state reads OPENING or CLOSING from then on, with the keyboard standing
    // still. The rule once waited for a tracker "settled open" before it
    // believed a hide, and after that it never did: under the "Discard
    // resource changes?" dialog the editor stayed shortened over an empty
    // band (Pixel 9a emulator, 2026-10-05). Whether the tracker has moved is
    // read from its height.
    const source = readFileSync(path.resolve(__dirname, '../components/keyboard-aware.tsx'), 'utf8');
    expect(source).toContain('keyboard.height.value');
    expect(source).not.toMatch(/keyboard\.state\b/);
    expect(source).not.toContain('KeyboardState');
  });
});
