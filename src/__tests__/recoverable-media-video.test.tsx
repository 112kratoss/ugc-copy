import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RecoverableMediaVideo from '@/app/components/RecoverableMediaVideo';
afterEach(() => vi.useRealTimers());
it('renews only after an explicit retry and loads paused', async () => {
 const resolveRetry = vi.fn(async () => ({ url: '/fresh.mp4', poster: '/fresh.webp' }));
 const { container } = render(<RecoverableMediaVideo url="/old.mp4" label="Demo" resolveRetry={resolveRetry} />);
 expect(resolveRetry).not.toHaveBeenCalled();
 expect(container.querySelector('video')!.autoplay).toBe(false);
 fireEvent.error(container.querySelector('video')!);
 fireEvent.click(screen.getByRole('button', { name: 'Reload video' }));
 await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/fresh.mp4'));
 expect(container.querySelector('video')).toHaveAttribute('poster', '/fresh.webp');
 fireEvent.loadedData(container.querySelector('video')!);
 expect(screen.queryByRole('status')).toBeNull();
});
it('retries the same input URL without needing a generation or paid action', async () => {
 const { container } = render(<RecoverableMediaVideo url="/input.mp4" label="Input" muted />);
 fireEvent.error(container.querySelector('video')!);
 fireEvent.click(screen.getByRole('button', { name: 'Reload video' }));
 expect(container.querySelector('video')).toHaveAttribute('src', '/input.mp4');
 expect(container.querySelector('video')!.muted).toBe(true);
});
it('bounds stalled renewal and ignores a late response after changing inputs', async () => {
 vi.useFakeTimers();
 let complete!: (value: {url:string}) => void;
 const resolveRetry = vi.fn<(signal: AbortSignal) => Promise<{url:string}>>(() => new Promise<{url:string}>(resolve => {complete=resolve;}));
 const { container, rerender } = render(<RecoverableMediaVideo url="/old.mp4" label="Demo" resolveRetry={resolveRetry} />);
 fireEvent.error(container.querySelector('video')!);
 fireEvent.click(screen.getByRole('button', { name: 'Reload video' }));
 await act(async () => { vi.advanceTimersByTime(30_000); });
 expect(resolveRetry.mock.calls[0][0].aborted).toBe(true);
 rerender(<RecoverableMediaVideo url="/different.mp4" label="Input" />);
 await act(async () => complete({url:'/late.mp4'}));
 expect(container.querySelector('video')).toHaveAttribute('src', '/different.mp4');
});
it('keeps recovery available when renewal is denied', async () => {
 const { container } = render(<RecoverableMediaVideo url="/old.mp4" label="Demo" resolveRetry={async () => {throw Error('Denied');}} />);
 fireEvent.error(container.querySelector('video')!);
 fireEvent.click(screen.getByRole('button', { name: 'Reload video' }));
 await screen.findByRole('button', { name: 'Reload video' });
 expect(container.querySelector('video')).toBeNull();
});

it('ignores cancellation of the discarded Strict Mode renewal', async () => {
 const resolveRetry = vi.fn((signal: AbortSignal) => new Promise<{url:string}>(resolve => {
   signal.addEventListener('abort', () => resolve({url:''}), {once:true});
   queueMicrotask(() => {if (!signal.aborted) resolve({url:'/fresh.mp4'});});
 }));
 const { container } = render(<StrictMode><RecoverableMediaVideo url="/old.mp4" label="Demo" resolveRetry={resolveRetry} /></StrictMode>);
 fireEvent.error(container.querySelector('video')!);
 fireEvent.click(screen.getByRole('button', { name: 'Reload video' }));
 await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/fresh.mp4'));
});
