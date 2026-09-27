import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MagicbookletApiClient } from '@/lib/api-client';

const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

const cryptoMock = vi.hoisted(() => ({ randomUUID: vi.fn(() => 'event-uuid') }));
vi.mock('expo-crypto', () => cryptoMock);

import { trackOnboardingEvent } from '@/lib/onboarding';

function apiRecording(recordOnboardingEvent: MagicbookletApiClient['recordOnboardingEvent']) {
  return { recordOnboardingEvent } as MagicbookletApiClient;
}

describe('trackOnboardingEvent', () => {
  beforeEach(() => {
    platform.OS = 'android';
    // Hermes has no Web Crypto global. Node's would mask the path a phone takes.
    vi.stubGlobal('crypto', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the event before its first await, so nothing has to load first', () => {
    const recordOnboardingEvent = vi.fn(async () => ({ success: true as const }));

    void trackOnboardingEvent(apiRecording(recordOnboardingEvent), 'started', { goal: 'image', step: 'goal' });

    // In a dev build a lazy import() is a bundle fetched from Metro, and while
    // Metro is down it rejects: every onboarding step then raised an uncaught
    // LoadBundleFromServerRequestError.
    expect(recordOnboardingEvent).toHaveBeenCalledTimes(1);
    expect(recordOnboardingEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientEventId: 'event-uuid',
      eventName: 'started',
      platform: 'android',
      goal: 'image',
      step: 'goal',
    }));
  });

  it('resolves when the request fails, because every caller fires and forgets', async () => {
    const recordOnboardingEvent = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(trackOnboardingEvent(apiRecording(recordOnboardingEvent), 'skipped')).resolves.toBeUndefined();
  });
});
