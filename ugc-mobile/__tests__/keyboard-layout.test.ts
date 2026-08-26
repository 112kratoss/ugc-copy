import { describe, expect, it } from 'vitest';

import { getKeyboardLift } from '../lib/keyboard';

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
