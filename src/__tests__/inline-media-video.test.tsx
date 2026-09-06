import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InlineMediaVideo from '@/app/components/InlineMediaVideo';
let observers: Array<{ callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }>;
beforeEach(() => {
  observers = [];
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { Object.defineProperty(this, 'paused', { configurable: true, value: true }); });
  vi.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 210, left: 0, right: 300, width: 300, height: 200 } as DOMRect);
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: IntersectionObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function start(video: HTMLVideoElement) {
  Object.defineProperty(video, 'paused', { configurable: true, value: false });
  fireEvent.play(video);
}
it('gives playback to the latest inline preview without pausing unrelated players', () => {
  const { container } = render(<><InlineMediaVideo src="/first.mp4" /><InlineMediaVideo src="/second.mp4" /><video src="/unrelated.mp4" /></>);
  const [first, second, unrelated] = [...container.querySelectorAll('video')];
  start(unrelated); start(first); start(second);
  expect(first.paused).toBe(true);
  expect(second.paused).toBe(false);
  expect(unrelated.paused).toBe(false);
});
it('pauses outside the viewport and does not resume on return', () => {
  const { container } = render(<InlineMediaVideo src="/first.mp4" />);
  const video = container.querySelector('video')!;
  start(video);
  observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(video.paused).toBe(true);
  observers[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(video.paused).toBe(true);
});
it('pauses in hidden tabs and rejects delayed autoplay while hidden', () => {
  const { container } = render(<InlineMediaVideo src="/first.mp4" />);
  const video = container.querySelector('video')!;
  start(video);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(video.paused).toBe(true);
  start(video);
  expect(video.paused).toBe(true);
});
it('honors intentional picture-in-picture until it exits', () => {
  const { container } = render(<InlineMediaVideo src="/first.mp4" />);
  const video = container.querySelector('video')!;
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: video });
  start(video);
  observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(video.paused).toBe(false);
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null });
  fireEvent(video, new Event('leavepictureinpicture'));
  expect(video.paused).toBe(true);
});
it('pauses and detaches observers on removal', () => {
  const { container, unmount } = render(<InlineMediaVideo src="/first.mp4" />);
  const video = container.querySelector('video')!;start(video);
  unmount();
  expect(video.paused).toBe(true);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
});
it('blocks a delayed play event when a scroll container clips the preview', () => {
  const { container } = render(<InlineMediaVideo src="/first.mp4" autoPlay />);
  const video = container.querySelector('video')!;
  observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  // Its window rectangle is still in bounds, but its scroll ancestor clips it.
  start(video);
  expect(video.paused).toBe(true);
});
