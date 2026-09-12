import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ResourceFileLink from '@/components/ResourceFileLink';
let tab: { opener: unknown; closed: boolean; close: ReturnType<typeof vi.fn>; location: { replace: ReturnType<typeof vi.fn> } };
beforeEach(() => {
  tab = { opener: window, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('signs each click and severs the reserved window opener', async () => {
  const resolveUrl = vi.fn().mockResolvedValueOnce('https://example.com/fresh-1').mockResolvedValueOnce('https://example.com/fresh-2');
  render(<ResourceFileLink label="Attachment" resolveUrl={resolveUrl} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Attachment' }));
  expect(tab.opener).toBeNull();
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('https://example.com/fresh-1'));
  fireEvent.click(screen.getByRole('button', { name: 'Open Attachment' }));
  await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('https://example.com/fresh-2'));
  expect(resolveUrl).toHaveBeenCalledTimes(2);
});
it('bounds hanging signing, closes the blank tab and allows retry', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  render(<ResourceFileLink label="Attachment" resolveUrl={s => { signal = s; return new Promise(() => {}); }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Attachment' }));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(signal?.aborted).toBe(true);
  expect(tab.close).toHaveBeenCalled();
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('button')).toBeEnabled();
});
it('aborts on unmount and makes popup blocking actionable without caching a link', () => {
  let signal: AbortSignal | undefined;
  const view = render(<ResourceFileLink label="Attachment" resolveUrl={s => { signal = s; return new Promise(() => {}); }} />);
  fireEvent.click(screen.getByRole('button'));
  view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(tab.close).toHaveBeenCalled();
  vi.mocked(window.open).mockReturnValue(null);
  const resolveUrl = vi.fn();
  render(<ResourceFileLink label="Attachment" resolveUrl={resolveUrl} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('alert')).toHaveTextContent('Allow popups');
  expect(resolveUrl).not.toHaveBeenCalled();
});
