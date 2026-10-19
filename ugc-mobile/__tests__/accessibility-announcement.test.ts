import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  announce: vi.fn(),
  announceWithOptions: vi.fn() as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: native.announce,
    get announceForAccessibilityWithOptions() {
      return native.announceWithOptions;
    },
  },
  Platform: {
    get OS() {
      return native.os;
    },
  },
}));

import { announceQueued } from '@/lib/accessibility-announcement';

afterEach(() => {
  native.os = 'ios';
  native.announce.mockClear();
  native.announceWithOptions = vi.fn();
});

// Review finding #11: "Saved" spoken over the saver notice cut VoiceOver off
// mid-sentence; queued, it is read after.
describe('announceQueued', () => {
  it('waits behind what VoiceOver is reading on iOS', () => {
    announceQueued('Saved');

    expect(native.announceWithOptions?.mock.calls).toEqual([['Saved', { queue: true }]]);
    expect(native.announce).not.toHaveBeenCalled();
  });

  it('announces as before on Android, which has no queue', () => {
    native.os = 'android';

    announceQueued('Removed from saved');

    expect(native.announce.mock.calls).toEqual([['Removed from saved']]);
    expect(native.announceWithOptions).not.toHaveBeenCalled();
  });

  it('still announces on an iOS runtime without the queued call', () => {
    native.announceWithOptions = undefined;

    announceQueued('Saved');

    expect(native.announce.mock.calls).toEqual([['Saved']]);
  });
});
