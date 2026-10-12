import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceMediaPreview, { createBatchedUrlResolver } from '@/components/ResourceMediaPreview';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('createBatchedUrlResolver', () => {
  it('answers the keys asked for in one tick with one load, and fails a key it leaves out', async () => {
    const load = vi.fn(async (keys: string[]) => new Map(keys.filter(key => key !== 'gone').map(key => [key, `/${key}.png`])));
    const resolve = createBatchedUrlResolver(load, 25);

    const results = await Promise.allSettled([resolve('a'), resolve('b'), resolve('a'), resolve('gone')]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toEqual(['a', 'b', 'gone']);
    expect(results.map(result => result.status === 'fulfilled' ? result.value : 'failed'))
      .toEqual(['/a.png', '/b.png', '/a.png', 'failed']);
  });

  it('splits one tick into loads of at most the batch size', async () => {
    const load = vi.fn(async (keys: string[]) => new Map(keys.map(key => [key, `/${key}`])));
    const resolve = createBatchedUrlResolver(load, 2);

    await Promise.all(['a', 'b', 'c'].map(key => resolve(key)));

    expect(load.mock.calls.map(([keys]) => keys)).toEqual([['a', 'b'], ['c']]);
  });

  it('lets each caller abort alone, and aborts the shared load once every caller has', async () => {
    const signals: AbortSignal[] = [];
    const load = vi.fn((_keys: string[], signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<ReadonlyMap<string, string>>(() => {});
    });
    const resolve = createBatchedUrlResolver(load, 25);
    const first = new AbortController();
    const second = new AbortController();
    const firstUrl = resolve('a', first.signal);
    const secondUrl = resolve('b', second.signal);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);

    first.abort();
    await expect(firstUrl).rejects.toBeDefined();
    expect(signals[0].aborted).toBe(false);
    second.abort();
    await expect(secondUrl).rejects.toBeDefined();
    expect(signals[0].aborted).toBe(true);

    // A caller gone before its tick is flushed never reaches a load.
    const third = new AbortController();
    const thirdUrl = resolve('c', third.signal);
    third.abort();
    await expect(thirdUrl).rejects.toBeDefined();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fails every caller in a load that fails', async () => {
    const resolve = createBatchedUrlResolver(async () => { throw new Error('Rate limited'); }, 25);

    const results = await Promise.allSettled([resolve('a'), resolve('b')]);

    expect(results.map(result => result.status === 'rejected' ? (result.reason as Error).message : 'ok'))
      .toEqual(['Rate limited', 'Rate limited']);
  });
});

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

it('renews a broken image and ignores completion from the old element', async () => {
  const resolveUrl = vi.fn().mockResolvedValueOnce('/expired.jpg').mockResolvedValueOnce('/fresh.jpg');
  const { container } = render(<ResourceMediaPreview mediaType="image" label="Reference" resolveUrl={resolveUrl} />);
  await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', '/expired.jpg'));
  const stale = container.querySelector('img')!;
  fireEvent.error(stale);
  fireEvent.load(stale);
  expect(screen.getByRole('button', { name: 'Reload image' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reload image' }));
  await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', '/fresh.jpg'));
  fireEvent.load(container.querySelector('img')!);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps a restoration action responsive to parent progress while showing a media error', () => {
  const view = render(<ResourceMediaPreview mediaType="audio" label="Audio" url="/clip.wav" errorAction={<button>Restore preview</button>} />);
  fireEvent.error(view.container.querySelector('audio')!);
  view.rerender(<ResourceMediaPreview mediaType="audio" label="Audio" url="/clip.wav" errorAction={<button disabled>Restoring...</button>} />);
  expect(screen.getByRole('button', { name: 'Restoring...' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Restore preview' })).toBeNull();
});
