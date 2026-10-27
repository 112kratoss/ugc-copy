import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InlineMediaVideo from '@/components/InlineMediaVideo';
import { INLINE_MEDIA_HAND_BACK_DELAY_MS } from '@/components/useInlineMediaPlayback';
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function start(video: HTMLVideoElement) {
  Object.defineProperty(video, 'paused', { configurable: true, value: false });
  fireEvent.play(video);
}
/** A pause that reaches the page as a browser's does: the element pauses, then says so. */
function stop(video: HTMLVideoElement) {
  video.pause();
  fireEvent.pause(video);
}
/** `play()` as a browser answers it: the element starts and says so. */
function answerPlay() {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  return vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    start(this as HTMLVideoElement);
    return Promise.resolve();
  });
}
function waitOutHandBack() {
  act(() => { vi.advanceTimersByTime(INLINE_MEDIA_HAND_BACK_DELAY_MS); });
}
it('plays an autoplaying preview again once the one whose start paused it stops, while it is still in view', () => {
  vi.useFakeTimers();
  const play = answerPlay();
  const { container } = render(<><InlineMediaVideo src="/feed.mp4" autoPlay /><InlineMediaVideo src="/shelf.mp4" autoPlay /></>);
  const [feed, shelf] = [...container.querySelectorAll('video')];
  start(feed); start(shelf);
  expect(feed.paused).toBe(true);
  stop(shelf);
  expect(play).not.toHaveBeenCalled();
  waitOutHandBack();
  expect(play).toHaveBeenCalledOnce();
  expect(feed.paused).toBe(false);
  expect(shelf.paused).toBe(true);
});
it('hands back when the playing preview goes, unless the next one starts within the delay', () => {
  vi.useFakeTimers();
  const play = answerPlay();
  const page = (shelfSrc: string | null) => (
    <><InlineMediaVideo src="/feed.mp4" autoPlay />{shelfSrc ? <InlineMediaVideo key={shelfSrc} src={shelfSrc} autoPlay /> : null}</>
  );
  const { container, rerender } = render(page('/a.mp4'));
  const feed = container.querySelector('video')!;
  start(feed); start(container.querySelectorAll('video')[1]);
  // The shelf swaps card a's clip for card b's: b starts a moment later, and the feed waits on.
  rerender(page('/b.mp4'));
  start(container.querySelectorAll('video')[1]);
  waitOutHandBack();
  expect(play).not.toHaveBeenCalled();
  expect(feed.paused).toBe(true);
  // The shelf scrolls away and its clip goes: the feed's plays again.
  rerender(page(null));
  waitOutHandBack();
  expect(play).toHaveBeenCalledOnce();
  expect(feed.paused).toBe(false);
});
it('hands back when the playing preview is paused and goes before its pause event is dispatched', () => {
  vi.useFakeTimers();
  const play = answerPlay();
  const page = (withShelf: boolean) => (
    <><InlineMediaVideo src="/feed.mp4" autoPlay />{withShelf ? <InlineMediaVideo src="/shelf.mp4" autoPlay /> : null}</>
  );
  const { container, rerender } = render(page(true));
  const [feed, shelf] = [...container.querySelectorAll('video')];
  start(feed); start(shelf);
  // The shelf scrolls away: its clip is paused as it leaves the view, and the
  // shelf drops it in the same moment, before the browser says it paused.
  shelf.pause();
  rerender(page(false));
  waitOutHandBack();
  expect(play).toHaveBeenCalledOnce();
  expect(feed.paused).toBe(false);
});
it('leaves paused a preview that left the view meanwhile, or one the viewer started by hand', () => {
  vi.useFakeTimers();
  const play = answerPlay();
  const { container } = render(<><InlineMediaVideo src="/feed.mp4" autoPlay /><InlineMediaVideo src="/manual.mp4" /><InlineMediaVideo src="/shelf.mp4" autoPlay /></>);
  const [feed, manual, shelf] = [...container.querySelectorAll('video')];
  start(manual); start(shelf);
  stop(shelf);
  waitOutHandBack();
  expect(manual.paused).toBe(true);
  start(feed); start(shelf);
  observers[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  stop(shelf);
  waitOutHandBack();
  expect(play).not.toHaveBeenCalled();
  expect(feed.paused).toBe(true);
});
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
