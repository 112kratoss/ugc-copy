import { describe, expect, it } from 'vitest';

import { getEditProfileScrollPadding } from '../lib/edit-profile-layout';

describe('edit profile layout', () => {
  it('adds enough scroll padding for the keyboard to uncover the bio field', () => {
    expect(getEditProfileScrollPadding({ bottomInset: 24, keyboardHeight: 320 })).toBeGreaterThanOrEqual(340);
  });

  it('keeps normal bottom spacing when the keyboard is closed', () => {
    expect(getEditProfileScrollPadding({ bottomInset: 24, keyboardHeight: 0 })).toBe(52);
  });
});
