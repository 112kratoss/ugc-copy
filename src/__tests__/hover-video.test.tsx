import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HoverVideo } from '@/app/components/HoverVideo';

const observerCallbacks: IntersectionObserverCallback[] = [];

class IntersectionObserverMock {
  readonly root = null;
  readonly rootMargin = '320px 0px';
  readonly thresholds = [0];

  constructor(callback: IntersectionObserverCallback) {
    observerCallbacks.push(callback);
  }

  disconnect = vi.fn();
  observe = vi.fn();
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();
}

function enterViewport() {
  act(() => {
    observerCallbacks[0]?.([
      { isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
  });
}

describe('HoverVideo', () => {
  beforeEach(() => {
    observerCallbacks.length = 0;
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the original source detached until a nearby card is hovered', () => {
    const { container } = render(
      <HoverVideo
        src="https://example.com/video.mp4"
        poster="https://example.com/video-preview.webp"
      />
    );
    const video = container.querySelector('video');

    expect(video).not.toBeNull();
    expect(video).not.toHaveAttribute('src');
    expect(video).not.toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('poster', 'https://example.com/video-preview.webp');
    expect(video).toHaveAttribute('preload', 'none');

    enterViewport();
    expect(video).not.toHaveAttribute('src');

    fireEvent.mouseEnter(video!);
    expect(video).toHaveAttribute('src', 'https://example.com/video.mp4');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    fireEvent.mouseLeave(video!);
    expect(video).not.toHaveAttribute('src');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('attaches and autoplays an explicitly requested video only near the viewport', () => {
    const { container } = render(
      <HoverVideo
        src="https://example.com/video.mp4"
        autoPlay
      />
    );
    const video = container.querySelector('video');

    expect(video).not.toHaveAttribute('src');
    enterViewport();

    expect(video).toHaveAttribute('src', 'https://example.com/video.mp4');
    expect(video).toHaveAttribute('autoplay');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it('does not attach autoplay media when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    const { container } = render(
      <HoverVideo src="https://example.com/video.mp4" autoPlay />
    );
    const video = container.querySelector('video');
    enterViewport();

    expect(video).not.toHaveAttribute('src');
    expect(video).not.toHaveAttribute('autoplay');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('does not attach preview video bytes when data saver is enabled', () => {
    vi.stubGlobal('navigator', {
      connection: {
        saveData: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    const { container } = render(
      <HoverVideo src="https://example.com/video.mp4" autoPlay />
    );
    const video = container.querySelector('video');
    enterViewport();

    expect(video).not.toHaveAttribute('src');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
});
