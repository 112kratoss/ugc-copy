import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ResourceMediaPreview from '@/app/components/ResourceMediaPreview';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('renews failed audio through the authorized resolver and leaves retry paused', async () => {
  const resolveUrl = vi.fn().mockResolvedValueOnce('/expired.wav').mockResolvedValueOnce('/fresh.wav');
  const { container } = render(<ResourceMediaPreview mediaType="audio" label="Reference" resolveUrl={resolveUrl} />);
  const audio = await waitFor(() => {
    const element = container.querySelector('audio');
    expect(element).toHaveAttribute('src', '/expired.wav');
    return element!;
  });
  fireEvent.error(audio);
  expect(container.querySelector('audio')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reload audio' }));
  await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', '/fresh.wav'));
  expect(resolveUrl).toHaveBeenCalledTimes(2);
  expect(container.querySelector('audio')).not.toHaveAttribute('autoplay');
});

it('bounds a stalled signing request and aborts it before retry or unmount', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const resolveUrl = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>(() => {});
  });
  const { unmount } = render(<ResourceMediaPreview mediaType="video" label="Reference" resolveUrl={resolveUrl} />);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.getByRole('button', { name: 'Reload video' })).toBeInTheDocument();
  expect(signals[0].aborted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Reload video' }));
  expect(signals).toHaveLength(2);
  unmount();
  expect(signals[1].aborted).toBe(true);
});

it('does not time out idle audio; times out stalled playback and ignores late ready events', async () => {
  vi.useFakeTimers();
  const { container } = render(<ResourceMediaPreview mediaType="audio" label="Reference" url="/audio.wav" />);
  const audio = container.querySelector('audio')!;
  fireEvent.loadStart(audio);
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(audio.preload).toBe('none');
  fireEvent.waiting(audio);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  fireEvent.canPlay(audio);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(container.querySelector('audio')).toBeNull();
});

it('cancels the video deadline when frames load and exposes signing failures', async () => {
  vi.useFakeTimers();
  const view = render(<ResourceMediaPreview mediaType="video" label="Reference" url="/video.mp4" />);
  fireEvent.loadedData(view.container.querySelector('video')!);
  await act(() => vi.advanceTimersByTimeAsync(31_000));
  expect(screen.queryByRole('alert')).toBeNull();
  view.unmount();
  render(<ResourceMediaPreview mediaType="audio" label="Reference" resolveUrl={async () => { throw new Error('Offline'); }} />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'Reload audio' })).toBeInTheDocument();
});
