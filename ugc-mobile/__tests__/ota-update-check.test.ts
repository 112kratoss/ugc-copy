import { describe, expect, it, vi } from 'vitest';

import { FOREGROUND_RELOAD_THRESHOLD_MS } from '../lib/app-update-policy';
import {
  FETCHED_UPDATE_APPLY_WINDOW_MS,
  OTA_CHECK_MIN_INTERVAL_MS,
  checkAndFetchUpdate,
  effectiveBackgroundedForMs,
  shouldCheckForUpdateOnReturn,
} from '../lib/ota-update-check';

const NOW = 10 * 60 * 60 * 1000;
const base = {
  enabled: true,
  isUpdatePending: false,
  checking: false,
  hasActiveWork: false,
  backgroundedForMs: FOREGROUND_RELOAD_THRESHOLD_MS,
  lastCheckAtMs: null,
  nowMs: NOW,
};

// Audit 2026-11-27, finding 2: nothing asked the update server after launch, so a fix reached a
// phone only at its next cold start. A return after the reload threshold now asks.
describe('whether a return from the background asks the update server', () => {
  it('asks after the foreground-reload threshold', () => {
    expect(shouldCheckForUpdateOnReturn(base)).toBe(true);
  });

  it.each([
    ['in Expo Go or the dev client, where expo-updates is inert', { enabled: false }],
    ['while an update already waits', { isUpdatePending: true }],
    ['while a check is still running', { checking: true }],
    ['during a purchase, a generation or an upload', { hasActiveWork: true }],
    ['after a shorter absence', { backgroundedForMs: FOREGROUND_RELOAD_THRESHOLD_MS - 1 }],
    ['within the minimum interval of the last check', { lastCheckAtMs: NOW - OTA_CHECK_MIN_INTERVAL_MS + 1 }],
  ])('does not ask %s', (_name, overrides) => {
    expect(shouldCheckForUpdateOnReturn({ ...base, ...overrides })).toBe(false);
  });

  it('asks again once the minimum interval has passed', () => {
    expect(shouldCheckForUpdateOnReturn({ ...base, lastCheckAtMs: NOW - OTA_CHECK_MIN_INTERVAL_MS })).toBe(true);
  });
});

describe('checking and fetching', () => {
  it('fetches only when the server has a new update', async () => {
    const fetchUpdateAsync = vi.fn(async () => ({ isNew: true }));
    await expect(checkAndFetchUpdate({
      checkForUpdateAsync: async () => ({ isAvailable: true }),
      fetchUpdateAsync,
    })).resolves.toBe('fetched');
    expect(fetchUpdateAsync).toHaveBeenCalledTimes(1);

    const notCalled = vi.fn();
    await expect(checkAndFetchUpdate({
      checkForUpdateAsync: async () => ({ isAvailable: false }),
      fetchUpdateAsync: notCalled,
    })).resolves.toBe('none');
    expect(notCalled).not.toHaveBeenCalled();
  });

  it('swallows every failure', async () => {
    await expect(checkAndFetchUpdate({
      checkForUpdateAsync: async () => { throw new Error('offline'); },
      fetchUpdateAsync: vi.fn(),
    })).resolves.toBe('failed');
    await expect(checkAndFetchUpdate({
      checkForUpdateAsync: async () => ({ isAvailable: true }),
      fetchUpdateAsync: async () => { throw new Error('disk full'); },
    })).resolves.toBe('failed');
    await expect(checkAndFetchUpdate({
      checkForUpdateAsync: () => { throw new Error('sync throw'); },
      fetchUpdateAsync: vi.fn(),
    })).resolves.toBe('failed');
  });
});

// A download that lands long after the return must not reload under someone already using the app.
describe('how long the gate reads the app as away', () => {
  const away = FOREGROUND_RELOAD_THRESHOLD_MS + 1;

  it('keeps the absence for an update that waited at the return', () => {
    expect(effectiveBackgroundedForMs({ backgroundedForMs: away, pendingAtReturn: true, returnedAtMs: NOW - 3_600_000, nowMs: NOW })).toBe(away);
  });

  it('keeps it for an update fetched just after the return, and drops it once that window has passed', () => {
    expect(effectiveBackgroundedForMs({ backgroundedForMs: away, pendingAtReturn: false, returnedAtMs: NOW - 5_000, nowMs: NOW })).toBe(away);
    expect(effectiveBackgroundedForMs({ backgroundedForMs: away, pendingAtReturn: false, returnedAtMs: NOW - FETCHED_UPDATE_APPLY_WINDOW_MS - 1, nowMs: NOW })).toBe(0);
  });

  it('keeps it before any return (a cold start)', () => {
    expect(effectiveBackgroundedForMs({ backgroundedForMs: 0, pendingAtReturn: false, returnedAtMs: null, nowMs: NOW })).toBe(0);
  });
});
