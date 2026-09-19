import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VIEWER_REFRESH_SPINNER_DELAY_MS,
  refreshSpinnerShown,
  useViewerRefreshSpinner,
} from '../lib/viewer-refresh-indicator';

type Input = { fetching: boolean; manualRefreshes: number };

function mountSpinner(initial: Input) {
  let shown = false;
  let setInput!: React.Dispatch<React.SetStateAction<Input>>;
  function Host() {
    const [input, set] = React.useState(initial);
    setInput = set;
    shown = useViewerRefreshSpinner(input);
    return null;
  }
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => { tree = renderer.create(<Host />); });
  return {
    shown: () => shown,
    update: (next: Partial<Input>) => renderer.act(() => setInput((current) => ({ ...current, ...next }))),
    advance: (ms: number) => renderer.act(() => { vi.advanceTimersByTime(ms); }),
    unmount: () => renderer.act(() => tree.unmount()),
  };
}

describe('the reel refresh spinner', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows a refresh nobody asked for only once it has been pending a while', () => {
    const spinner = mountSpinner({ fetching: true, manualRefreshes: 0 });
    expect(spinner.shown()).toBe(false);
    spinner.advance(VIEWER_REFRESH_SPINNER_DELAY_MS - 1);
    expect(spinner.shown()).toBe(false);
    spinner.advance(1);
    expect(spinner.shown()).toBe(true);
    spinner.update({ fetching: false });
    expect(spinner.shown()).toBe(false);
    spinner.unmount();
  });

  it('starts the wait again for each fetch', () => {
    const spinner = mountSpinner({ fetching: true, manualRefreshes: 0 });
    spinner.advance(VIEWER_REFRESH_SPINNER_DELAY_MS);
    expect(spinner.shown()).toBe(true);
    spinner.update({ fetching: false });
    spinner.update({ fetching: true });
    expect(spinner.shown()).toBe(false);
    spinner.advance(VIEWER_REFRESH_SPINNER_DELAY_MS - 1);
    expect(spinner.shown()).toBe(false);
    spinner.advance(1);
    expect(spinner.shown()).toBe(true);
    spinner.unmount();
  });

  it('shows at once for a refresh the reader asked for, and only that one', () => {
    const spinner = mountSpinner({ fetching: false, manualRefreshes: 0 });
    spinner.update({ manualRefreshes: 1, fetching: true });
    expect(spinner.shown()).toBe(true);
    spinner.update({ fetching: false });
    expect(spinner.shown()).toBe(false);
    // The next fetch the app starts on its own waits again.
    spinner.update({ fetching: true });
    expect(spinner.shown()).toBe(false);
    spinner.advance(VIEWER_REFRESH_SPINNER_DELAY_MS);
    expect(spinner.shown()).toBe(true);
    spinner.unmount();
  });

  it('shows at once when the reader asks during a fetch already running', () => {
    const spinner = mountSpinner({ fetching: true, manualRefreshes: 0 });
    spinner.advance(100);
    spinner.update({ manualRefreshes: 1 });
    expect(spinner.shown()).toBe(true);
    spinner.unmount();
  });

  it('states the rule', () => {
    expect(refreshSpinnerShown({ fetching: false, elapsedMs: 5000, requested: true })).toBe(false);
    expect(refreshSpinnerShown({ fetching: true, elapsedMs: VIEWER_REFRESH_SPINNER_DELAY_MS - 1, requested: false })).toBe(false);
    expect(refreshSpinnerShown({ fetching: true, elapsedMs: VIEWER_REFRESH_SPINNER_DELAY_MS, requested: false })).toBe(true);
    expect(refreshSpinnerShown({ fetching: true, elapsedMs: 0, requested: true })).toBe(true);
  });

  it('is what the viewer draws by', () => {
    const viewer = readFileSync(join(__dirname, '..', 'app/viewer.tsx'), 'utf8');
    expect(viewer).toContain('sourceQuery.isFetching && activeItem && refreshSpinnerDue ? (');
    expect(viewer).toContain('useViewerRefreshSpinner({ fetching: sourceQuery.isFetching, manualRefreshes })');
    expect(viewer).toContain('setManualRefreshes((count) => count + 1);');
  });
});
