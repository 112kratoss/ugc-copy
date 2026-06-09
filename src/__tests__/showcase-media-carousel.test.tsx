import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';

const observerCallbacks: IntersectionObserverCallback[] = [];

class IntersectionObserverMock {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0, 0.45, 1];

  constructor(callback: IntersectionObserverCallback) {
    observerCallbacks.push(callback);
  }

  disconnect = vi.fn();
  observe = vi.fn();
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();
}

describe('ShowcaseMediaCarousel', () => {
  beforeEach(() => {
    observerCallbacks.length = 0;
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('plays a feed video only while enough of the card is visible', () => {
    render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mediaItems={[
          {
            id: 'video-1',
            url: 'https://example.com/clip.mp4',
            mediaKind: 'video',
            contentType: 'video/mp4',
            originalName: 'clip.mp4',
            width: 1080,
            height: 1350,
            durationSeconds: 8,
            sortOrder: 0,
          },
        ]}
      />
    );

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(observerCallbacks).toHaveLength(1);

    act(() => {
      observerCallbacks[0]([
        { isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    act(() => {
      observerCallbacks[0]([
        { isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
});
