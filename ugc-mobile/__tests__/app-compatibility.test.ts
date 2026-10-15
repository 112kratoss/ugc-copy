import { describe, expect, it, vi } from 'vitest';

import { checkAppVersionFloor, isAppVersionBelowMinimum, parseSemanticVersion } from '../lib/app-compatibility';

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

describe('checkAppVersionFloor (the update screen’s Check again)', () => {
  const answer = (minimumAppVersion: string) => ({ getAppVersion: vi.fn(async () => ({ mobileCompatibility: { minimumAppVersion } })) });

  it('is met when the server’s floor is at or below this build', async () => {
    await expect(checkAppVersionFloor(answer('0.0.5'), '0.1.8')).resolves.toBe('met');
    await expect(checkAppVersionFloor(answer('0.1.8'), '0.1.8')).resolves.toBe('met');
  });

  it('is below when the floor is still above this build', async () => {
    await expect(checkAppVersionFloor(answer('0.1.10'), '0.1.8')).resolves.toBe('below');
  });

  it('fails, rather than guessing, when the floor could not be read', async () => {
    const offline = { getAppVersion: vi.fn(async () => { throw new Error('Network request failed'); }) };
    await expect(checkAppVersionFloor(offline, '0.1.8')).resolves.toBe('failed');
    const shapeless = { getAppVersion: vi.fn(async () => ({}) as never) };
    await expect(checkAppVersionFloor(shapeless, '0.1.8')).resolves.toBe('failed');
  });

  it('reads a malformed floor as no floor, as the start-up check does', async () => {
    await expect(checkAppVersionFloor(answer('latest'), '0.1.8')).resolves.toBe('met');
  });
});
