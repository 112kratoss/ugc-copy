import { describe, expect, it, vi } from 'vitest';

// lib/motion tolerates minimal react-native mocks by design; the spec under
// test is pure and needs no native module behaviour.
vi.mock('react-native', () => ({}));

import { getOverlayPresenceSpec } from '../lib/motion';

describe('overlay presence spec', () => {
  it('enters slower than it exits, settling from a subtle scale', () => {
    const spec = getOverlayPresenceSpec(false);
    expect(spec.enterDurationMs).toBeGreaterThan(spec.exitDurationMs);
    // Nothing appears from nothing: the surface settles from a slight scale,
    // never grows from zero.
    expect(spec.enterScaleFrom).toBeLessThan(1);
    expect(spec.enterScaleFrom).toBeGreaterThan(0.9);
  });

  it('collapses to an instant cut under reduced motion', () => {
    expect(getOverlayPresenceSpec(true)).toEqual({
      enterDurationMs: 0,
      exitDurationMs: 0,
      enterScaleFrom: 1,
    });
  });
});
