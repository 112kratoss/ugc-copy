import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('plays an explicitly autoplaying feed video only while enough of the card is visible', () => {
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        autoPlayVideo
        mediaItems={[
          {
            id: 'video-1',
            url: 'https://example.com/clip.mp4',
            previewUrl: 'https://example.com/clip-preview.webp',
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
    const video = container.querySelector('video');

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(video).not.toHaveAttribute('src');
    expect(video).toHaveAttribute('poster', 'https://example.com/clip-preview.webp');
    expect(video).toHaveAttribute('preload', 'none');
    expect(observerCallbacks).toHaveLength(1);

    act(() => {
      observerCallbacks[0]([
        { isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(video).toHaveAttribute('src', 'https://example.com/clip.mp4');

    act(() => {
      observerCallbacks[0]([
        { isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(video).not.toHaveAttribute('src');
  });

  it('keeps feed video poster-only by default and loads it on hover', () => {
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mediaItems={[
          {
            id: 'video-1',
            url: 'https://example.com/clip.mp4',
            previewUrl: 'https://example.com/clip-preview.webp',
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
    const video = container.querySelector('video');
    const carousel = video?.parentElement?.parentElement;

    act(() => {
      observerCallbacks[0]([
        { isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(video).not.toHaveAttribute('src');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    fireEvent.mouseEnter(carousel!);
    expect(video).toHaveAttribute('src', 'https://example.com/clip.mp4');
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    fireEvent.mouseLeave(carousel!);
    expect(video).not.toHaveAttribute('src');
  });

  it('renders the lightweight preview for feed images while retaining the original fallback', () => {
    render(
      <ShowcaseMediaCarousel
        title="Campaign still"
        mediaItems={[
          {
            id: 'image-1',
            url: 'https://example.com/original.jpg',
            previewUrl: 'https://example.com/preview.webp',
            mediaKind: 'image',
            contentType: 'image/jpeg',
            originalName: 'original.jpg',
            width: 1080,
            height: 1350,
            durationSeconds: null,
            sortOrder: 0,
          },
        ]}
      />
    );

    expect(screen.getByRole('img', { name: 'Campaign still' }))
      .toHaveAttribute('src', 'https://example.com/preview.webp');
  });
});
