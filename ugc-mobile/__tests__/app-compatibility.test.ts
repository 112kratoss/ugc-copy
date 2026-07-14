import { describe, expect, it } from 'vitest';

import { isAppVersionBelowMinimum, parseSemanticVersion } from '../lib/app-compatibility';

describe('mobile app compatibility', () => {
  it('compares semantic versions without string ordering bugs', () => {
    expect(isAppVersionBelowMinimum('0.0.9', '0.0.10')).toBe(true);
    expect(isAppVersionBelowMinimum('1.2.0', '1.1.9')).toBe(false);
    expect(isAppVersionBelowMinimum('1.0.0-beta', '1.0.0')).toBe(false);
  });

  it('does not block on malformed server policy values', () => {
    expect(parseSemanticVersion('latest')).toBeNull();
    expect(isAppVersionBelowMinimum('0.0.1', 'latest')).toBe(false);
  });
});
