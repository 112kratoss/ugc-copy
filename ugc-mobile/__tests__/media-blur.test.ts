import { afterEach, describe, expect, it } from 'vitest';

import {
  nativeBlurRadius,
  resetNativeImageCapabilitiesForTests,
  setNativeImageCapabilities,
} from '../lib/media-blur';

describe('nativeBlurRadius', () => {
  afterEach(() => {
    resetNativeImageCapabilitiesForTests();
  });

  it('never asks an Android build whose expo-image still blurs through RenderScript', () => {
    expect(nativeBlurRadius(24, 'android')).toBeUndefined();
    setNativeImageCapabilities(null);
    expect(nativeBlurRadius(24, 'android')).toBeUndefined();
    setNativeImageCapabilities({});
    expect(nativeBlurRadius(24, 'android')).toBeUndefined();
    // Only the exact advertisement counts: a truthy string is not a capability.
    setNativeImageCapabilities({ softwareBlurRadius: 'yes' });
    expect(nativeBlurRadius(24, 'android')).toBeUndefined();
  });

  it('asks an Android build that advertises a software blur', () => {
    setNativeImageCapabilities({ softwareBlurRadius: true });
    expect(nativeBlurRadius(24, 'android')).toBe(24);
  });

  it('always asks iOS, whose blur never touches RenderScript', () => {
    expect(nativeBlurRadius(24, 'ios')).toBe(24);
  });

  it('treats no blur as no blur everywhere', () => {
    setNativeImageCapabilities({ softwareBlurRadius: true });
    expect(nativeBlurRadius(0, 'android')).toBeUndefined();
    expect(nativeBlurRadius(0, 'ios')).toBeUndefined();
    expect(nativeBlurRadius(-3, 'ios')).toBeUndefined();
  });
});
