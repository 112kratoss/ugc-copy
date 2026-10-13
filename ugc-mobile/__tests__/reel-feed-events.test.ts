import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { REEL_QUICK_SKIP_MIN_MS, reelLeaveEventType, resourceOpenGate } from '../lib/reel-feed-events';

describe('what the reel files as the reader leaves a post', () => {
  it('files a quick skip only from 250 ms, as the web reel does, and a dwell from a second', () => {
    // A flick across several posts rests on each for a frame or two; those
    // used to count as skips, and quick_skip weighs -1 in the v4 ranker.
    expect(REEL_QUICK_SKIP_MIN_MS).toBe(250);
    expect(reelLeaveEventType(0)).toBeNull();
    expect(reelLeaveEventType(249)).toBeNull();
    expect(reelLeaveEventType(250)).toBe('quick_skip');
    expect(reelLeaveEventType(999)).toBe('quick_skip');
    expect(reelLeaveEventType(1000)).toBe('dwell');
  });
});

describe("a post's resources opened", () => {
  it('passes each delivery once for the whole app, and nothing without a delivery', () => {
    // Home's recipe chip opens the reel on that post's Details, where the
    // resources card is: one open, reported once.
    expect(resourceOpenGate.pass('delivery-chip')).toBe(true);
    expect(resourceOpenGate.pass('delivery-chip')).toBe(false);
    expect(resourceOpenGate.pass(null)).toBe(false);
    expect(resourceOpenGate.pass(undefined)).toBe(false);
  });

  it('is the one gate Home and the reel report through', () => {
    for (const path of ['components/home-dashboard.tsx', 'app/viewer.tsx']) {
      const source = readFileSync(path, 'utf8');
      expect(source).toMatch(/import \{[^}]*\bresourceOpenGate\b[^}]*\} from '@\/lib\/reel-feed-events';/);
      expect(source).toContain('resourceOpenGate.pass(item.recommendation?.deliveryId)');
      expect(source).not.toContain('createFeedDeliveryOnceGate()');
    }
  });
});
