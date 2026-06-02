import { describe, expect, it, vi } from 'vitest';

import { getProfileCreditsOrNull } from '../lib/auth-profile';
import type { ProfileResponse } from '../lib/types';

function profile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: 'user-1',
    username: 'creator',
    displayName: 'Creator',
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    credits: null,
    ...overrides,
  };
}

describe('getProfileCreditsOrNull', () => {
  it('returns profile credits when the API is reachable', async () => {
    await expect(getProfileCreditsOrNull({
      getProfile: vi.fn(async () => profile({ credits: 42 })),
    })).resolves.toBe(42);
  });

  it('does not throw when the profile API is unreachable after auth', async () => {
    const warn = vi.fn();

    await expect(getProfileCreditsOrNull({
      getProfile: vi.fn(async () => {
        throw new TypeError('Network request failed');
      }),
    }, warn)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      'Failed to refresh profile after auth',
      expect.any(TypeError)
    );
  });
});
