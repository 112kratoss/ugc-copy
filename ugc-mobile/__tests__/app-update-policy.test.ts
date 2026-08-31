import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetActivityLocksForTest,
  acquireActivityLock,
  activeWorkReasons,
  hasActiveWork,
  subscribeToActivity,
} from '../lib/app-activity';
import {
  FOREGROUND_RELOAD_THRESHOLD_MS,
  decideUpdateAction,
  decideUpdateActionNow,
  type UpdateDecisionContext,
} from '../lib/app-update-policy';

const IDLE: UpdateDecisionContext = {
  isUpdatePending: true,
  isCritical: false,
  hasActiveWork: false,
  backgroundedForMs: FOREGROUND_RELOAD_THRESHOLD_MS,
  criticalPromptDismissed: false,
};

afterEach(() => {
  __resetActivityLocksForTest();
});

describe('activity locks', () => {
  it('holds until released, and releases idempotently', () => {
    expect(hasActiveWork()).toBe(false);

    const release = acquireActivityLock('generation');
    expect(hasActiveWork()).toBe(true);
    expect(activeWorkReasons()).toEqual(['generation']);

    release();
    expect(hasActiveWork()).toBe(false);
    // A second release must not disturb anything — useEffect cleanups can and
    // do run twice under StrictMode.
    release();
    expect(hasActiveWork()).toBe(false);
  });

  it('never lets one activity release another', () => {
    // The bug a boolean would have: upload finishes, clears the flag, and the
    // still-running generation is silently declared idle.
    const releaseGeneration = acquireActivityLock('generation');
    const releaseUpload = acquireActivityLock('upload');
    expect(activeWorkReasons()).toEqual(['generation', 'upload']);

    releaseUpload();
    expect(hasActiveWork()).toBe(true);
    expect(activeWorkReasons()).toEqual(['generation']);

    releaseGeneration();
    expect(hasActiveWork()).toBe(false);
  });

  it('deduplicates reasons but not locks', () => {
    const releaseFirst = acquireActivityLock('upload');
    const releaseSecond = acquireActivityLock('upload');
    expect(activeWorkReasons()).toEqual(['upload']);

    releaseFirst();
    expect(hasActiveWork()).toBe(true);

    releaseSecond();
    expect(hasActiveWork()).toBe(false);
  });

  it('notifies subscribers on both transitions', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToActivity((busy) => seen.push(busy));

    const release = acquireActivityLock('purchase');
    release();
    unsubscribe();
    acquireActivityLock('purchase');

    expect(seen).toEqual([true, false]);
  });
});

describe('decideUpdateAction', () => {
  it('waits when there is nothing to apply', () => {
    expect(decideUpdateAction({ ...IDLE, isUpdatePending: false })).toBe('wait');
    expect(decideUpdateAction({ ...IDLE, isUpdatePending: false, isCritical: true })).toBe('wait');
  });

  it('applies a routine update silently after a long enough absence', () => {
    expect(decideUpdateAction(IDLE)).toBe('apply-silently');
  });

  it('waits when the app has not been away long enough', () => {
    expect(
      decideUpdateAction({ ...IDLE, backgroundedForMs: FOREGROUND_RELOAD_THRESHOLD_MS - 1 }),
    ).toBe('wait');
    // A foreground event is not the only reason this runs; zero means "no
    // absence to speak of", which must never be treated as a safe pause.
    expect(decideUpdateAction({ ...IDLE, backgroundedForMs: 0 })).toBe('wait');
  });

  it('prompts for a critical update without waiting for the threshold', () => {
    expect(
      decideUpdateAction({ ...IDLE, isCritical: true, backgroundedForMs: 0 }),
    ).toBe('prompt');
  });

  it('never reloads while the app is busy, critical included', () => {
    // The rule the product chose deliberately: losing a paid-for render is
    // worse than running an old build for another ten minutes.
    expect(decideUpdateAction({ ...IDLE, hasActiveWork: true })).toBe('wait');
    expect(decideUpdateAction({ ...IDLE, hasActiveWork: true, isCritical: true })).toBe('wait');
    expect(
      decideUpdateAction({
        ...IDLE,
        hasActiveWork: true,
        isCritical: true,
        backgroundedForMs: FOREGROUND_RELOAD_THRESHOLD_MS * 10,
      }),
    ).toBe('wait');
  });

  it('stops prompting once dismissed, but can still land silently later', () => {
    const dismissed = { ...IDLE, isCritical: true, criticalPromptDismissed: true };

    // Same session, user still active: no second prompt.
    expect(decideUpdateAction({ ...dismissed, backgroundedForMs: 0 })).toBe('wait');
    // They put the phone down for an hour: it applies quietly, no nagging.
    expect(decideUpdateAction(dismissed)).toBe('apply-silently');
  });

  it('reads the live activity registry through decideUpdateActionNow', () => {
    expect(decideUpdateActionNow({
      isUpdatePending: true,
      isCritical: false,
      backgroundedForMs: FOREGROUND_RELOAD_THRESHOLD_MS,
      criticalPromptDismissed: false,
    })).toBe('apply-silently');

    const release = acquireActivityLock('generation');
    expect(decideUpdateActionNow({
      isUpdatePending: true,
      isCritical: false,
      backgroundedForMs: FOREGROUND_RELOAD_THRESHOLD_MS,
      criticalPromptDismissed: false,
    })).toBe('wait');

    release();
  });

  it('keeps the threshold long enough that a glance at another app is safe', () => {
    // Pinned rather than asserted loosely: shortening this is a product
    // decision about interrupting people, not a tuning knob.
    expect(FOREGROUND_RELOAD_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });
});
