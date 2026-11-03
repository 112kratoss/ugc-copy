import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ current: 'active', listeners: new Set<(state: string) => void>() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() { return appState.current; },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

import { whenClockReaches } from '../lib/wall-clock-timer';

const HOUR_MS = 60 * 60 * 1000;

function setAppState(state: string) {
  appState.current = state;
  appState.listeners.forEach((listener) => listener(state));
}

describe('whenClockReaches', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    appState.current = 'active';
    appState.listeners.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls back once, when the clock gets there', () => {
    const reached = vi.fn();
    whenClockReaches(HOUR_MS, reached);

    vi.advanceTimersByTime(HOUR_MS - 1);
    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reached).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOUR_MS);
    expect(reached).toHaveBeenCalledTimes(1);
    // Done with: it no longer listens for the app.
    expect(appState.listeners.size).toBe(0);
  });

  it('calls back at once, on the next tick, for a time already past', () => {
    const reached = vi.fn();
    whenClockReaches(-1, reached);

    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  // setTimeout fires a wait longer than its longest at once.
  it('waits past setTimeout’s longest in parts', () => {
    const reached = vi.fn();
    const thirtyDays = 30 * 24 * HOUR_MS;
    whenClockReaches(thirtyDays, reached);

    vi.advanceTimersByTime(2_147_483_647);
    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(thirtyDays - 2_147_483_647);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  // Android's timers count a clock that stops while the phone sleeps.
  it('reads the clock again as the app comes back, and calls back if the time passed meanwhile', () => {
    const reached = vi.fn();
    whenClockReaches(HOUR_MS, reached);

    setAppState('background');
    vi.setSystemTime(2 * HOUR_MS);
    setAppState('active');
    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting when the app comes back before the time', () => {
    const reached = vi.fn();
    whenClockReaches(HOUR_MS, reached);

    setAppState('background');
    vi.setSystemTime(HOUR_MS / 2);
    setAppState('active');
    vi.advanceTimersByTime(HOUR_MS / 2 - 1);
    expect(reached).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('never calls back once stopped, and stops listening', () => {
    const reached = vi.fn();
    const stop = whenClockReaches(HOUR_MS, reached);
    expect(appState.listeners.size).toBe(1);

    stop();
    stop();
    setAppState('background');
    vi.setSystemTime(2 * HOUR_MS);
    setAppState('active');
    vi.advanceTimersByTime(2 * HOUR_MS);

    expect(reached).not.toHaveBeenCalled();
    expect(appState.listeners.size).toBe(0);
  });
});
