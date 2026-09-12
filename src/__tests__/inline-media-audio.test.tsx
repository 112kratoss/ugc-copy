import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InlineMediaAudio from '@/components/InlineMediaAudio';
import InlineMediaVideo from '@/components/InlineMediaVideo';

let observers: IntersectionObserverCallback[];

beforeEach(() => {
  observers = [];
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 10, bottom: 60, left: 0, right: 300, width: 300, height: 50,
  } as DOMRect);
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      observers.push(callback);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(media: HTMLMediaElement) {
  Object.defineProperty(media, 'paused', { configurable: true, value: false });
  fireEvent.play(media);
}

it('hands ownership between audio and video, including an editor opened over a playing node', () => {
  const { container } = render(<>
    <InlineMediaAudio src="/node.wav" controls />
    <InlineMediaAudio src="/editor.wav" controls />
    <InlineMediaVideo src="/result.mp4" controls />
  </>);
  const [node, editor, video] = Array.from(container.querySelectorAll<HTMLMediaElement>('audio,video'));

  start(node);
  start(editor);
  expect(node.paused).toBe(true);
  expect(editor.paused).toBe(false);
  start(video);
  expect(editor.paused).toBe(true);
  expect(video.paused).toBe(false);
  start(node);
  expect(video.paused).toBe(true);
});

it('pauses clipped audio, leaves it paused on return and avoids eager preview downloads', () => {
  const { container } = render(<InlineMediaAudio src="/node.wav" controls />);
  const audio = container.querySelector('audio')!;
  expect(audio.preload).toBe('none');
  start(audio);

  observers[0]([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(audio.paused).toBe(true);
  observers[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(audio.paused).toBe(true);
});

it('pauses background audio and cleans up playback when the editor closes', () => {
  const { container, unmount } = render(<InlineMediaAudio src="/editor.wav" controls />);
  const audio = container.querySelector('audio')!;
  start(audio);

  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(audio.paused).toBe(true);
  start(audio);
  expect(audio.paused).toBe(true);
  hidden.mockReturnValue(false);
  fireEvent(document, new Event('visibilitychange'));
  expect(audio.paused).toBe(true);
  start(audio);
  expect(audio.paused).toBe(false);
  unmount();
  expect(audio.paused).toBe(true);
});
