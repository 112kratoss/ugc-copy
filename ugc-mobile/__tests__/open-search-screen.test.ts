import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The press that opens search out of its control (lib/open-search-screen.ts): the control's
// frame when it answers, and search all the same when it does not (review of #812, 2).
const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ router: { push: mocks.push } }));

import { openSearchScreenFrom, SEARCH_OPEN_MEASURE_WAIT_MS, searchScreenOpener } from '../lib/open-search-screen';

describe('opening search out of the pressed control', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.push.mockClear();
    searchScreenOpener.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    searchScreenOpener.reset();
  });

  it('opens at once with the frame a view answers before the measure returns (Fabric)', () => {
    openSearchScreenFrom({ measureInWindow: (callback) => callback(270, 72, 48, 48) }, 'button');
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(searchScreenOpener.takeOrigin()).toEqual({ x: 270, y: 72, width: 48, height: 48, kind: 'button' });
    vi.advanceTimersByTime(SEARCH_OPEN_MEASURE_WAIT_MS * 2);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('opens without a control when the view never answers, or throws', () => {
    openSearchScreenFrom({ measureInWindow: () => {} }, 'button');
    expect(mocks.push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEARCH_OPEN_MEASURE_WAIT_MS);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(searchScreenOpener.takeOrigin()).toBeNull();

    searchScreenOpener.reset();
    openSearchScreenFrom({ measureInWindow: () => { throw new Error('detached'); } }, 'field');
    vi.advanceTimersByTime(SEARCH_OPEN_MEASURE_WAIT_MS);
    expect(mocks.push).toHaveBeenCalledTimes(2);
  });

  it('takes a late answer only if search has not opened yet, once', () => {
    let answer: ((x: number, y: number, width: number, height: number) => void) | null = null;
    openSearchScreenFrom({ measureInWindow: (callback) => { answer = callback; } }, 'button');
    vi.advanceTimersByTime(SEARCH_OPEN_MEASURE_WAIT_MS);
    answer!(270, 72, 48, 48);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });
});
