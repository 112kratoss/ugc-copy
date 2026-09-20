import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios', Version: '26.4' }));
vi.mock('react-native', () => ({ Platform: platform }));

import { isAppleZoomAvailable } from '../lib/apple-zoom-available';

const bridgeless = globalThis as { RN$Bridgeless?: boolean };

afterEach(() => {
  platform.OS = 'ios';
  platform.Version = '26.4';
  delete bridgeless.RN$Bridgeless;
});

describe('where the reel\'s native zoom runs', () => {
  it('needs iOS 18 on the bridgeless runtime, and nothing else', () => {
    expect(isAppleZoomAvailable()).toBe(false);
    bridgeless.RN$Bridgeless = true;
    expect(isAppleZoomAvailable()).toBe(true);

    platform.Version = '17.6';
    expect(isAppleZoomAvailable()).toBe(false);

    platform.Version = '18.0';
    platform.OS = 'android';
    expect(isAppleZoomAvailable()).toBe(false);
  });
});
