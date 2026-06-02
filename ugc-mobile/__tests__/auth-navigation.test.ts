import { describe, expect, it, vi } from 'vitest';

import { leaveAuthScreen } from '../lib/auth-navigation';

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
