import { describe, expect, it } from 'vitest';

import { getEditProfileScrollPadding } from '../lib/edit-profile-layout';

describe('edit profile layout', () => {
  it('keeps a gutter below the form clear of the home indicator', () => {
    expect(getEditProfileScrollPadding({ bottomInset: 24 })).toBe(52);
  });

  it('still leaves a gutter on devices without a bottom inset', () => {
    expect(getEditProfileScrollPadding({ bottomInset: 0 })).toBe(28);
  });
});
