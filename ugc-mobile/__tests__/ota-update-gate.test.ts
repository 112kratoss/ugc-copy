import { describe, expect, it } from 'vitest';

import {
  IDLE_CLOCK,
  advanceBackgroundClock,
  isReturnFromBackground,
  readCriticalFlag,
} from '../lib/ota-update-gate';

describe('readCriticalFlag', () => {
  it('only accepts a literal true', () => {
    expect(readCriticalFlag({ manifest: { extra: { critical: true } } })).toBe(true);
    // A publish command with `--extra critical=true` sends a string. Treating
    // that as urgent would let a typo earn the right to interrupt someone.
    expect(readCriticalFlag({ manifest: { extra: { critical: 'true' } } })).toBe(false);
    expect(readCriticalFlag({ manifest: { extra: { critical: 1 } } })).toBe(false);
    expect(readCriticalFlag({ manifest: { extra: { critical: false } } })).toBe(false);
  });

  it('is safe on every shape expo-updates can hand back', () => {
    expect(readCriticalFlag(undefined)).toBe(false);
    expect(readCriticalFlag(null)).toBe(false);
    expect(readCriticalFlag({})).toBe(false);
    // A rollback update carries manifest: undefined by design.
    expect(readCriticalFlag({ manifest: undefined })).toBe(false);
    expect(readCriticalFlag({ manifest: {} })).toBe(false);
    expect(readCriticalFlag({ manifest: { extra: null } })).toBe(false);
    expect(readCriticalFlag('nonsense')).toBe(false);
  });
});

describe('advanceBackgroundClock', () => {
  it('measures how long the app was away', () => {
    const left = advanceBackgroundClock(IDLE_CLOCK, 'background', 1_000);
    expect(left).toEqual({ backgroundedAt: 1_000, backgroundedForMs: 0 });

    const returned = advanceBackgroundClock(left, 'active', 1_000 + 45 * 60 * 1_000);
    expect(returned.backgroundedAt).toBeNull();
    expect(returned.backgroundedForMs).toBe(45 * 60 * 1_000);
  });

  it('does not restart the clock on the inactive → background pair', () => {
    // Every iOS backgrounding emits both. Restarting on the second would
    // discard the elapsed time and silently prevent the update from applying.
    const inactive = advanceBackgroundClock(IDLE_CLOCK, 'inactive', 1_000);
    const background = advanceBackgroundClock(inactive, 'background', 1_500);
    expect(background.backgroundedAt).toBe(1_000);

    const returned = advanceBackgroundClock(background, 'active', 1_000 + 60_000);
    expect(returned.backgroundedForMs).toBe(60_000);
  });

  it('reports zero when the app never actually left', () => {
    const returned = advanceBackgroundClock(IDLE_CLOCK, 'active', 5_000);
    expect(returned).toEqual({ backgroundedAt: null, backgroundedForMs: 0 });
  });

  it('never reports a negative duration if the clock moves backwards', () => {
    const left = advanceBackgroundClock(IDLE_CLOCK, 'background', 10_000);
    const returned = advanceBackgroundClock(left, 'active', 9_000);
    expect(returned.backgroundedForMs).toBe(0);
  });
});

describe('isReturnFromBackground', () => {
  it('is true only when the app had actually gone away', () => {
    const away = advanceBackgroundClock(IDLE_CLOCK, 'background', 1_000);
    expect(isReturnFromBackground(away, 'active')).toBe(true);
    expect(isReturnFromBackground(IDLE_CLOCK, 'active')).toBe(false);
  });

  it('treats inactive as staying, not returning', () => {
    // A notification-centre pull or a call banner reports `inactive` while the
    // app is still visibly on screen. Reloading there is a reload under the
    // user's eyes.
    const away = advanceBackgroundClock(IDLE_CLOCK, 'background', 1_000);
    expect(isReturnFromBackground(away, 'inactive')).toBe(false);
    expect(isReturnFromBackground(away, 'background')).toBe(false);
  });
});
