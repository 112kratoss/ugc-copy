import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GenerationResultVideo from '@/components/GenerationResultVideo';

const props = { generationId: 'generation-1', outputUrl: '/original.mp4', accessToken: 'token-1', onOriginalResolved: vi.fn() };
const descriptor = (renditionUrl: string | null = '/small.mp4') => ({
  generations: [{ id: props.generationId, media: { kind: 'video', url: '/fresh-original.mp4', renditionUrl } }],
});
const response = (payload = descriptor()) => ({ ok: true, json: async () => payload });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); props.onOriginalResolved.mockClear(); });

describe('generation result video delivery', () => {
  it('can reopen an owned archived generation referenced by a saved workflow', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(
      new URL(url, 'https://app.example').searchParams.get('includeArchived') === 'true'
        ? descriptor()
        : { generations: [] },
    )));
    const { container } = render(<GenerationResultVideo {...props} />);
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/small.mp4'));
  });

  it('supports a standalone non-looping viewer without a download callback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const { container } = render(<GenerationResultVideo {...props} onOriginalResolved={undefined} loop={false} />);
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/small.mp4'));
    expect(container.querySelector('video')!.loop).toBe(false);
    fireEvent.loadedData(container.querySelector('video')!);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resolves a rendition before mounting the video and renews it on Retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(descriptor('/renewed.mp4')));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<GenerationResultVideo {...props} />);
    expect(container.querySelector('video')).toBeNull();
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/small.mp4'));
    expect(props.onOriginalResolved).toHaveBeenCalledWith({ outputUrl: '/original.mp4', url: '/fresh-original.mp4' });
    fireEvent.error(container.querySelector('video')!);
    expect(screen.getByRole('alert')).toHaveTextContent('Video couldn’t load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/renewed.mp4'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generations?id=generation-1&detail=summary&includeArchived=true');
  });

  it('falls back to the freshly signed original when no rendition exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(descriptor(null))));
    const { container } = render(<GenerationResultVideo {...props} />);
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/fresh-original.mp4'));
  });

  it.each([403, 404, 503])('shows a recoverable error on lookup HTTP %s without playing the stale URL', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
    const { container } = render(<GenerationResultVideo {...props} />);
    await screen.findByRole('button', { name: 'Retry' });
    expect(container.querySelector('video')).toBeNull();
  });

  it('does not use another generation returned by an invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ generations: [{ ...descriptor().generations[0], id: 'other' }] })));
    const { container } = render(<GenerationResultVideo {...props} />);
    await screen.findByRole('button', { name: 'Retry' });
    expect(container.querySelector('video')).toBeNull();
  });

  it('bounds a response whose headers arrive but body never finishes and ignores late completion', async () => {
    vi.useFakeTimers();
    let resolveBody!: (payload: ReturnType<typeof descriptor>) => void;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise((resolve) => { resolveBody = resolve; }) });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<GenerationResultVideo {...props} />);
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { resolveBody(descriptor()); });
    expect(container.querySelector('video')).toBeNull();
  });

  it('times out media that never produces a frame', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const { container } = render(<GenerationResultVideo {...props} />);
    await act(async () => {});
    expect(container.querySelector('video')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });

  it('keeps the same player on token renewal but retries with the latest token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const { container, rerender } = render(<GenerationResultVideo {...props} />);
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video')!;
    rerender(<GenerationResultVideo {...props} accessToken="token-2" />);
    expect(container.querySelector('video')).toBe(video);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.error(video);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer token-2');
  });

  it('aborts a replaced result and ignores its delayed response', async () => {
    let resolveBody!: (payload: ReturnType<typeof descriptor>) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => new Promise((resolve) => { resolveBody = resolve; }) })
      .mockResolvedValueOnce(response({ generations: [{ id: 'generation-2', media: { kind: 'video', url: '/second.mp4', renditionUrl: null } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { container, rerender } = render(<GenerationResultVideo {...props} />);
    await act(async () => {});
    rerender(<GenerationResultVideo {...props} generationId="generation-2" outputUrl="/second.mp4" />);
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/second.mp4'));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { resolveBody(descriptor()); });
    expect(container.querySelector('video')).toHaveAttribute('src', '/second.mp4');
  });
});
