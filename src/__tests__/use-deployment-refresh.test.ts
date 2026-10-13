import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MARKER_KEY = 'magicbooklet:deployment-refresh:last-build-id';

let visibility: DocumentVisibilityState = 'visible';
let latestBuildId = 'build-2';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// The newer build is page-lifetime module state, so each test loads a fresh page.
async function loadHook() {
  vi.resetModules();
  return (await import('@/lib/use-deployment-refresh')).useDeploymentRefresh;
}

describe('useDeploymentRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    latestBuildId = 'build-2';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    document.documentElement.dataset.buildId = 'build-1';
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ buildId: latestBuildId }), { status: 200 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'visibilityState');
    delete document.documentElement.dataset.buildId;
    window.sessionStorage.clear();
  });

  it('tells a visible page about a newer build and never reloads it', async () => {
    const useDeploymentRefresh = await loadHook();
    const reload = vi.fn();
    const { result } = renderHook(() => useDeploymentRefresh(true, { reload }));

    await advance(0);
    expect(result.current.newBuildAvailable).toBe(true);
    await advance(60_000);
    expect(reload).not.toHaveBeenCalled();
    // A reload the creator makes at the Generate press is covered by the marker.
    expect(window.sessionStorage.getItem(MARKER_KEY)).toBe('build-2');
  });

  it('reloads a page that stays hidden onto the newer build', async () => {
    const useDeploymentRefresh = await loadHook();
    const reload = vi.fn();
    renderHook(() => useDeploymentRefresh(true, { reload }));
    await advance(0);

    setVisibility('hidden');
    await advance(9_999);
    expect(reload).not.toHaveBeenCalled();
    await advance(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves a page alone that is shown again before the wait ends', async () => {
    const useDeploymentRefresh = await loadHook();
    const reload = vi.fn();
    renderHook(() => useDeploymentRefresh(true, { reload }));
    await advance(0);

    setVisibility('hidden');
    await advance(5_000);
    setVisibility('visible');
    await advance(60_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('neither checks nor reloads while a run is in flight', async () => {
    const useDeploymentRefresh = await loadHook();
    const reload = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => useDeploymentRefresh(enabled, { reload }),
      { initialProps: { enabled: true } },
    );
    await advance(0);
    setVisibility('hidden');
    await advance(5_000);

    // The creator pressed Generate: the hidden-page reload that was due must not land mid-run.
    rerender({ enabled: false });
    const checks = vi.mocked(fetch).mock.calls.length;
    await advance(60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.length).toBe(checks);
    expect(result.current.newBuildAvailable).toBe(true);
  });

  it('does not check at all while disabled from the start', async () => {
    const useDeploymentRefresh = await loadHook();
    const reload = vi.fn();
    const { result } = renderHook(() => useDeploymentRefresh(false, { reload }));
    setVisibility('hidden');

    await advance(60_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.newBuildAvailable).toBe(false);
  });

  it('remembers the newer build when the hook turns back on after a run', async () => {
    const useDeploymentRefresh = await loadHook();
    const reload = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => useDeploymentRefresh(enabled, { reload }),
      { initialProps: { enabled: true } },
    );
    await advance(0);
    rerender({ enabled: false });
    rerender({ enabled: true });
    await advance(0);

    // The marker this page wrote must not read as a reload that already failed.
    expect(result.current.newBuildAvailable).toBe(true);
    setVisibility('hidden');
    await advance(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not offer again a build this tab already reloaded for and still did not get', async () => {
    window.sessionStorage.setItem(MARKER_KEY, 'build-2');
    const useDeploymentRefresh = await loadHook();
    const reload = vi.fn();
    const { result } = renderHook(() => useDeploymentRefresh(true, { reload }));
    await advance(0);
    setVisibility('hidden');

    await advance(60_000);
    expect(result.current.newBuildAvailable).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('checks every 15 seconds, starting at once', async () => {
    latestBuildId = 'build-1';
    const useDeploymentRefresh = await loadHook();
    const { result } = renderHook(() => useDeploymentRefresh(true, { reload: vi.fn() }));

    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/app-version', { cache: 'no-store' });
    expect(result.current.newBuildAvailable).toBe(false);

    latestBuildId = 'build-2';
    await advance(14_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.newBuildAvailable).toBe(true);
  });
});
