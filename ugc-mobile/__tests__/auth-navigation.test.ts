import { describe, expect, it, vi } from 'vitest';

import { completeAuthScreen, leaveAuthScreen, normalizeAuthReturnTo } from '../lib/auth-navigation';

describe('leaveAuthScreen', () => {
  it('uses navigation history when a back stack exists', () => {
    const router = {
      canGoBack: vi.fn(() => true),
      back: vi.fn(),
      replace: vi.fn(),
    };

    leaveAuthScreen(router);

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('returns to the tabs root when there is no back stack', () => {
    const router = {
      canGoBack: vi.fn(() => false),
      back: vi.fn(),
      replace: vi.fn(),
    };

    leaveAuthScreen(router);

    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
    expect(router.back).not.toHaveBeenCalled();
  });
});

describe('auth return navigation', () => {
  it('accepts only local in-app return paths', () => {
    expect(normalizeAuthReturnTo('/creators/luna?tab=unlocks')).toBe('/creators/luna?tab=unlocks');
    expect(normalizeAuthReturnTo([' /creators/luna ', '/ignored'])).toBe('/creators/luna');
    expect(normalizeAuthReturnTo('https://example.com')).toBeNull();
    expect(normalizeAuthReturnTo('//example.com/path')).toBeNull();
    expect(normalizeAuthReturnTo('/creators\\luna')).toBeNull();
  });

  it('replaces auth with a valid creator return path', () => {
    const router = {
      canGoBack: vi.fn(() => true),
      back: vi.fn(),
      replace: vi.fn(),
    };

    completeAuthScreen(router, '/creators/luna');

    expect(router.replace).toHaveBeenCalledWith('/creators/luna');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('uses the normal auth exit when a return path is unsafe', () => {
    const router = {
      canGoBack: vi.fn(() => false),
      back: vi.fn(),
      replace: vi.fn(),
    };

    completeAuthScreen(router, 'https://example.com');

    expect(router.replace).toHaveBeenCalledWith('/(tabs)');
  });
});
