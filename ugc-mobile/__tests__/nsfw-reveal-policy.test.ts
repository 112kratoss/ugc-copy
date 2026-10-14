import { describe, expect, it } from 'vitest';

import { canRevealNsfwInApp, getMatureReveal } from '@/lib/nsfw-reveal-policy';

describe('NSFW reveal policy', () => {
  it('keeps mature posts covered on Android until the app has an age screen', () => {
    expect(canRevealNsfwInApp('android')).toBe(false);
  });

  it('keeps the website opt-in reveal on iOS', () => {
    expect(canRevealNsfwInApp('ios')).toBe(true);
  });
});

describe('showing a mature purchase', () => {
  it('shows it on iOS only once the website preference is on', () => {
    expect(getMatureReveal('ios', true)).toBe('show');
    expect(getMatureReveal('ios', false)).toBe('website');
  });

  it('offers nothing on iOS while the preference is still being read', () => {
    expect(getMatureReveal('ios', null)).toBe('pending');
  });

  it('never shows it on Android, whatever the preference says', () => {
    for (const showMature of [true, false, null]) {
      expect(getMatureReveal('android', showMature)).toBe('never');
    }
  });
});
