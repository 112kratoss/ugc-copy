import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TemplateRunClient from '@/components/templates/TemplateRunClient';
import TemplateRunMedia from '@/components/templates/TemplateRunMedia';

// One object for every render: an effect that depends on a value the hook
// returns would otherwise run again on each one.
const auth = vi.hoisted(() => ({
  session: { access_token: 'token' },
  credits: 92,
  isLoading: false,
  refreshSessionState: vi.fn(),
}));
vi.mock('@/components/AuthProvider', () => ({ useAuth: () => auth }));

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

describe('the run page while a run is in progress', () => {
  const NOW_MS = Date.parse('2026-10-14T10:00:00.000Z');
  let visibility: DocumentVisibilityState = 'visible';

  const base64Url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  /** Every read signs the same file again: a new token, an hour to live. */
  const signed = (path: string, nonce: string) => {
    const claims = { url: path, exp: Math.floor(NOW_MS / 1000) + 3600, nonce };
    return `https://project.supabase.co/storage/v1/object/sign/${path}?token=${base64Url({ alg: 'HS256' })}.${base64Url(claims)}.signature`;
  };
  const inProgress = (read: number) => ({
    id: 'run-1',
    templateId: 'template-1',
    templateTitle: 'Rider transformation',
    userId: 'user-1',
    status: 'processing',
    inputSlots: [],
    inputs: {},
    steps: [
      {
        id: 'step-1', kind: 'generation', mediaKind: 'image', status: 'succeeded', label: 'Opening image',
        outputUrl: signed('generated_images/user-1/run-1/opening.png', `read-${read}`),
        errorMessage: null, failureCode: null, canRetry: false, estimatedRetryCredits: 8,
      },
      {
        id: 'step-2', kind: 'generation', mediaKind: 'video', status: 'processing', label: 'Final video',
        outputUrl: null, errorMessage: null, failureCode: null, canRetry: false, estimatedRetryCredits: 16,
      },
    ],
    result: null,
    estimatedTotalCredits: 24,
    estimatedRemainingCredits: 16,
    // Each read says something new, so a test can tell it reached the page.
    creditsUsed: 7 + read,
    errorMessage: null,
    isTest: false,
    createdAt: '2026-10-14T09:59:00.000Z',
    updatedAt: '2026-10-14T10:00:00.000Z',
  });
  const stubRunReads = () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/template-runs/run-1') {
        reads += 1;
        return { ok: true, status: 200, json: async () => ({ run: inProgress(reads) }) };
      }
      return { ok: true, status: 200, json: async () => ({ template: { id: 'template-1', slug: 'rider-transformation', name: 'Rider transformation' } }) };
    }));
    return () => reads;
  };

  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    // The clock moves with real time too, so the page's async reads settle; each poll is stepped by hand.
    vi.useFakeTimers({ now: NOW_MS, shouldAdvanceTime: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('keeps a finished step on screen while each read signs its file again', async () => {
    const reads = stubRunReads();
    render(<TemplateRunClient runId="run-1" />);
    const image = await screen.findByRole('img', { name: 'Opening image' });
    const firstAddress = image.getAttribute('src');
    // The image arrived with a read outside act: let its effects run before it loads.
    await act(async () => {});
    fireEvent.load(image);
    expect(screen.queryByText('Loading media…')).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(await screen.findByText('9 credits used')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(await screen.findByText('10 credits used')).toBeInTheDocument();

    expect(reads()).toBe(3);
    // The same element on the first read's address: the step was not loaded again.
    expect(screen.getByRole('img', { name: 'Opening image' })).toBe(image);
    expect(image).toHaveAttribute('src', firstAddress!);
    expect(screen.queryByText('Loading media…')).not.toBeInTheDocument();
  });

  // Fast Refresh and a hidden <Activity> run every cleanup and then every effect again.
  it('keeps a finished step on screen when every effect runs again, and keeps polling', async () => {
    const reads = stubRunReads();
    const page = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <TemplateRunClient runId="run-1" />
      </Activity>
    );
    const { rerender } = render(page('visible'));
    const image = await screen.findByRole('img', { name: 'Opening image' });
    await act(async () => {});
    fireEvent.load(image);

    rerender(page('hidden'));
    rerender(page('visible'));
    // The positive control: the read on arrival ran again, with a new address for the step.
    expect(await screen.findByText('9 credits used')).toBeInTheDocument();
    expect(reads()).toBe(2);
    expect(screen.getByRole('img', { name: 'Opening image' })).toBe(image);
    expect(screen.queryByText('Loading media…')).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(await screen.findByText('10 credits used')).toBeInTheDocument();
    expect(reads()).toBe(3);
  });

  it('reads nothing while the tab is hidden, and reads at once when it is shown again', async () => {
    const reads = stubRunReads();
    render(<TemplateRunClient runId="run-1" />);
    expect(await screen.findByText('8 credits used')).toBeInTheDocument();

    visibility = 'hidden';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads()).toBe(1);

    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(await screen.findByText('9 credits used')).toBeInTheDocument();
    expect(reads()).toBe(2);

    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(await screen.findByText('10 credits used')).toBeInTheDocument();
    expect(reads()).toBe(3);
  });
});
