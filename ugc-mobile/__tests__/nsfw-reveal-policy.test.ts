import { describe, expect, it } from 'vitest';

import { canRevealNsfwInApp } from '@/lib/nsfw-reveal-policy';

describe('NSFW reveal policy', () => {
  it('keeps mature posts covered on Android until the app has an age screen', () => {
    expect(canRevealNsfwInApp('android')).toBe(false);
  });

  it('keeps the website opt-in reveal on iOS', () => {
    expect(canRevealNsfwInApp('ios')).toBe(true);
  });
});
