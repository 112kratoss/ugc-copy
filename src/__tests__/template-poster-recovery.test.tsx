import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTemplatePosterRecovery } from '@/components/templates/useTemplatePosterRecovery';
import { getTemplate } from '@/components/templates/api';
import type { MediaTemplate } from '@/components/templates/types';
vi.mock('@/components/templates/api', () => ({ getTemplate: vi.fn() }));
const template = (id: string) => ({ id, thumbnailUrl: '/same.jpg' } as MediaTemplate);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getTemplate).mockImplementation(async id => template(id)); });
afterEach(() => vi.useRealTimers());

it('renews failed cards on reconnect without remounting healthy cards', async () => {
  const setTemplates = vi.fn();
  const { result } = renderHook(() => useTemplatePosterRecovery(setTemplates, 'token'));
  act(() => result.current.onPreviewError('failed'));
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(result.current.isReloading).toBe(false));
  expect(getTemplate).toHaveBeenCalledExactlyOnceWith('failed', 'token', expect.any(AbortSignal));
  expect(result.current.attempts).toEqual({ failed: 1 });
  expect(result.current.hasFailedPreviews).toBe(false);
  const healthy = template('healthy');
  expect(setTemplates.mock.calls[0][0]([healthy, template('failed')])).toEqual([healthy, template('failed')]);
});

it('caps concurrent renewals and deduplicates repeated reload actions', async () => {
  const releases: Array<() => void> = [];
  let active = 0, peak = 0;
  vi.mocked(getTemplate).mockImplementation(id => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    releases.push(() => { active--; resolve(template(id)); });
  }));
  const { result } = renderHook(() => useTemplatePosterRecovery(vi.fn()));
  act(() => { for (let i = 0; i < 9; i++) result.current.onPreviewError(String(i)); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.reloadPreviews(); void result.current.reloadPreviews(); });
  expect(getTemplate).toHaveBeenCalledTimes(4);
  while (releases.length) {
    await act(async () => { releases.splice(0).forEach(release => release()); });
  }
  await act(async () => pending);
  expect(getTemplate).toHaveBeenCalledTimes(9);
  expect(peak).toBe(4);
});

it('keeps renewal failures retryable and never replaces a card with a different template', async () => {
  vi.mocked(getTemplate).mockResolvedValue(template('other'));
  const { result } = renderHook(() => useTemplatePosterRecovery(vi.fn()));
  act(() => result.current.onPreviewError('failed'));
  await act(async () => result.current.reloadPreviews());
  expect(result.current.hasFailedPreviews).toBe(true);
});

it('cancels stalled renewal after the deadline and on unmount', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  vi.mocked(getTemplate).mockImplementation((_id, _token, s) => {
    signal = s!;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  });
  const { result, unmount } = renderHook(() => useTemplatePosterRecovery(vi.fn()));
  act(() => result.current.onPreviewError('failed'));
  act(() => { void result.current.reloadPreviews(); });
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(signal.aborted).toBe(true);
  expect(result.current.isReloading).toBe(false);
  expect(result.current.hasFailedPreviews).toBe(true);
  act(() => { void result.current.reloadPreviews(); });
  unmount();
  expect(signal.aborted).toBe(true);
});

it('preserves new poster failures reported while an earlier batch renews', async () => {
  let finish!: (value: MediaTemplate) => void;
  vi.mocked(getTemplate).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useTemplatePosterRecovery(vi.fn()));
  act(() => result.current.onPreviewError('first'));
  act(() => { void result.current.reloadPreviews(); });
  act(() => result.current.onPreviewError('second'));
  await act(async () => finish(template('first')));
  expect(result.current.hasFailedPreviews).toBe(true);
});
