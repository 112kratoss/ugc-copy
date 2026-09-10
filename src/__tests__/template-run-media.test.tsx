import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TemplateRunMedia from '@/app/components/templates/TemplateRunMedia';

const props = { runId: 'run-1', kind: 'video' as const, url: '/expired.mp4', token: 'token', alt: 'Result' };
const run = { id: 'run-1', result: { kind: 'video', url: '/renewed.mp4' }, steps: [{ id: 'step-1', kind: 'generation', mediaKind: 'image', status: 'succeeded', outputUrl: '/renewed.jpg' }] };
const response = (payload: unknown = run) => ({ ok: true, json: async () => ({ run: payload }) });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('template run media recovery', () => {
  it('renews a failed final video with only a run GET and updates the original download', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    const onResolved = vi.fn();
    const { container } = render(<TemplateRunMedia {...props} onResolved={onResolved} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('video')!.autoplay).toBe(false);
    fireEvent.error(container.querySelector('video')!);
    fireEvent.click(screen.getByRole('button', { name: 'Reload media' }));
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/renewed.mp4'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/template-runs/run-1');
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer token');
    expect(onResolved).toHaveBeenCalledWith({ outputUrl: '/expired.mp4', url: '/renewed.mp4' });
  });

  it('renews the requested intermediate image through its public step ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    const { container } = render(<TemplateRunMedia {...props} kind="image" stepId="step-1" />);
    fireEvent.error(container.querySelector('img')!);
    fireEvent.click(screen.getByRole('button', { name: 'Reload media' }));
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', '/renewed.jpg'));
    fireEvent.load(container.querySelector('img')!);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    { ...run, id: 'another-run' },
    { ...run, result: null },
    { ...run, result: { kind: 'image', url: '/wrong.jpg' } },
  ])('does not substitute missing or mismatched results', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(payload)));
    const { container } = render(<TemplateRunMedia {...props} />);
    fireEvent.error(container.querySelector('video')!);
    fireEvent.click(screen.getByRole('button', { name: 'Reload media' }));
    await screen.findByRole('button', { name: 'Reload media' });
    expect(container.querySelector('video')).toBeNull();
  });

  it('retains recovery after access denial without retrying generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<TemplateRunMedia {...props} />);
    fireEvent.error(container.querySelector('video')!);
    fireEvent.click(screen.getByRole('button', { name: 'Reload media' }));
    await screen.findByRole('button', { name: 'Reload media' });
    expect(container.querySelector('video')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled renewal body and ignores its eventual response', async () => {
    vi.useFakeTimers();
    let finish!: (payload: unknown) => void;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise((resolve) => { finish = resolve; }) });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<TemplateRunMedia {...props} />);
    fireEvent.error(container.querySelector('video')!);
    fireEvent.click(screen.getByRole('button', { name: 'Reload media' }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { finish({ run }); });
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload media' })).toBeInTheDocument();
  });
});

 it('plays and renews the optimized file while publishing the renewed original to downloads', async () => {
   vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...run, result: { ...run.result, renditionUrl: '/fresh-small.mp4', previewUrl: '/fresh.webp' } })));
   const onResolved = vi.fn();
   const { container } = render(<TemplateRunMedia {...props} renditionUrl="/small.mp4" previewUrl="/poster.webp" onResolved={onResolved} />);
   expect(container.querySelector('video')).toHaveAttribute('src', '/small.mp4');
   expect(container.querySelector('video')).toHaveAttribute('poster', '/poster.webp');
   fireEvent.error(container.querySelector('video')!);
   fireEvent.click(screen.getByRole('button', { name: 'Reload media' }));
   await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/fresh-small.mp4'));
   expect(container.querySelector('video')).toHaveAttribute('poster', '/fresh.webp');
   expect(onResolved).toHaveBeenCalledWith({ outputUrl: '/expired.mp4', url: '/renewed.mp4' });
 });
