import { describe, expect, it } from 'vitest';

import { imageRetryDelayMs } from '@/lib/media-performance';

// Contract tests for the auto-retry policy consumed by StableMediaImage.
// They pin the invariants the component relies on, not specific numbers, so
// they hold for the never-retry placeholder and for any bounded policy.
describe('imageRetryDelayMs', () => {
  it('gives up eventually so the failure UI can latch and fallbacks can run', () => {
    expect(imageRetryDelayMs(10)).toBeNull();
  });

  it('never schedules a retry with a negative delay', () => {
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      const delay = imageRetryDelayMs(attempt);
      if (delay !== null) {
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is deterministic in shape: once it stops, it stays stopped', () => {
    let stopped = false;
    for (let attempt = 0; attempt <= 20; attempt += 1) {
      const delay = imageRetryDelayMs(attempt);
      if (delay === null) {
        stopped = true;
      } else {
        expect(stopped).toBe(false);
      }
    }
    expect(stopped).toBe(true);
  });
});
