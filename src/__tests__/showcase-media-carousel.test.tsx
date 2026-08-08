import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import type { ShowcaseMediaItem } from '@/lib/showcase';

interface ObserverRegistration {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
}

const observerRegistrations: ObserverRegistration[] = [];

function getPlaybackObserver() {
  return observerRegistrations.find(({ options }) => options?.rootMargin !== '320px 0px');
}

function getNearViewportObserver() {
  return observerRegistrations.find(({ options }) => options?.rootMargin === '320px 0px');
}

class IntersectionObserverMock {
  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    observerRegistrations.push({ callback, options });
    this.rootMargin = options?.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options?.threshold)
      ? options.threshold
      : [options?.threshold ?? 0];
  }

  disconnect = vi.fn();
  observe = vi.fn();
  takeRecords = vi.fn(() => []);
  unobserve = vi.fn();
}

function createVideoItem(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
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
    ...overrides,
  };
}

describe('ShowcaseMediaCarousel', () => {
  beforeEach(() => {
    observerRegistrations.length = 0;
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720);
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
    expect(video).not.toHaveAttribute('poster');
    expect(video).toHaveAttribute('preload', 'none');
    expect(observerRegistrations).toHaveLength(2);

    act(() => {
      getPlaybackObserver()?.callback([
        { isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(video).toHaveAttribute('src', 'https://example.com/clip.mp4');
    expect(video).toHaveAttribute('poster', 'https://example.com/clip-preview.webp');

    act(() => {
      getPlaybackObserver()?.callback([
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
      getPlaybackObserver()?.callback([
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

  it('loads a deferred feed poster near the viewport without attaching or playing the video', () => {
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

    expect(video).not.toHaveAttribute('poster');
    expect(video).not.toHaveAttribute('src');

    act(() => {
      getNearViewportObserver()?.callback([
        { isIntersecting: true, intersectionRatio: 0 } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });

    expect(video).toHaveAttribute('poster', 'https://example.com/clip-preview.webp');
    expect(video).not.toHaveAttribute('src');
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('eagerly attaches a priority feed video poster without loading the video', () => {
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        priority
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

    expect(container.querySelector('video')).toHaveAttribute(
      'poster',
      'https://example.com/clip-preview.webp'
    );
    expect(container.querySelector('video')).not.toHaveAttribute('src');
  });

  it('keeps an exact priority poster override across feed rerenders', () => {
    const mediaItems = [{
      id: 'video-1',
      url: 'https://example.com/clip.mp4',
      previewUrl: 'https://example.com/clip-preview.webp',
      mediaKind: 'video' as const,
      contentType: 'video/mp4',
      originalName: 'clip.mp4',
      width: 1080,
      height: 1350,
      durationSeconds: 8,
      sortOrder: 0,
    }];
    const priorityPoster = {
      mediaId: 'video-1',
      dataUrl: 'data:image/webp;base64,UklGRgAAAABXRUJQ',
    };
    const { container, rerender } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        priority
        priorityPoster={priorityPoster}
        mediaItems={mediaItems}
      />
    );

    expect(container.querySelector('video')).toHaveAttribute('poster', priorityPoster.dataUrl);

    rerender(
      <ShowcaseMediaCarousel
        title="Campaign clip refreshed"
        priority
        priorityPoster={priorityPoster}
        mediaItems={[{ ...mediaItems[0], previewUrl: 'https://example.com/refreshed.webp' }]}
      />
    );

    expect(container.querySelector('video')).toHaveAttribute('poster', priorityPoster.dataUrl);
  });

  it('ignores a priority poster override for a different media item', () => {
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        priority
        priorityPoster={{
          mediaId: 'other-video',
          dataUrl: 'data:image/webp;base64,UklGRgAAAABXRUJQ',
        }}
        mediaItems={[{
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
        }]}
      />
    );

    expect(container.querySelector('video')).toHaveAttribute(
      'poster',
      'https://example.com/clip-preview.webp'
    );
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

    const image = screen.getByRole('img', { name: 'Campaign still' });
    expect(image).toHaveAttribute('src', 'https://example.com/preview.webp');
    expect(image).toHaveAttribute('loading', 'lazy');
  });

  it('supports a bounded detail viewport with an explicit full-screen action', () => {
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });

    try {
      const { container } = render(
        <ShowcaseMediaCarousel
          title="Campaign still"
          mode="detail"
          allowFullscreen
          viewportClassName="h-[min(62dvh,560px)]"
          mediaItems={[
            {
              id: 'image-1',
              url: 'https://example.com/original.jpg',
              mediaKind: 'image',
              contentType: 'image/jpeg',
              originalName: 'original.jpg',
              width: 1080,
              height: 1920,
              durationSeconds: null,
              sortOrder: 0,
            },
          ]}
        />
      );

      expect(container.querySelector('[data-showcase-media-viewport]')).toHaveClass('h-[min(62dvh,560px)]');
      fireEvent.click(screen.getByRole('button', { name: 'Open media full screen' }));
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
    }
  });

  it('reports an already-ready reel video without waiting for a loadedmetadata event', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
    const onMediaReady = vi.fn();
    const mediaItem = createVideoItem();

    render(
      <ShowcaseMediaCarousel
        title="Cached campaign clip"
        mode="reel"
        mediaItems={[mediaItem]}
        onMediaReady={onMediaReady}
      />
    );

    await waitFor(() => {
      expect(onMediaReady).toHaveBeenCalledWith(mediaItem);
    });
    expect(onMediaReady).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['loadeddata', (video: HTMLVideoElement) => fireEvent.loadedData(video)],
    ['canplay', (video: HTMLVideoElement) => fireEvent.canPlay(video)],
    ['playing', (video: HTMLVideoElement) => fireEvent.playing(video)],
  ] as const)('treats %s as a video readiness signal', (_eventName, signalReady) => {
    const onMediaReady = vi.fn();
    const mediaItem = createVideoItem();
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mode="reel"
        mediaItems={[mediaItem]}
        onMediaReady={onMediaReady}
      />
    );
    const video = container.querySelector('video');

    expect(video).not.toBeNull();
    signalReady(video!);

    expect(onMediaReady).toHaveBeenCalledWith(mediaItem);
  });

  it.each(['reel', 'detail'] as const)('uses the preview image as the %s video poster', (mode) => {
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mode={mode}
        mediaItems={[createVideoItem()]}
      />
    );

    expect(container.querySelector('video')).toHaveAttribute(
      'poster',
      'https://example.com/clip-preview.webp'
    );
  });

  it('reports the exact visible media item after sorting and changing slides', () => {
    const onMediaReady = vi.fn();
    const secondItem = createVideoItem({
      id: 'video-2',
      url: 'https://example.com/second.mp4',
      sortOrder: 1,
    });
    const firstItem = createVideoItem({
      id: 'video-1',
      url: 'https://example.com/first.mp4',
      sortOrder: 0,
    });
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clips"
        mode="reel"
        mediaItems={[secondItem, firstItem]}
        onMediaReady={onMediaReady}
      />
    );

    expect(container.querySelector('video')).toHaveAttribute('src', 'https://example.com/first.mp4');
    fireEvent.playing(container.querySelector('video')!);
    expect(onMediaReady).toHaveBeenLastCalledWith(firstItem);

    fireEvent.click(screen.getByRole('button', { name: 'Next media' }));
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://example.com/second.mp4');
    fireEvent.loadedData(container.querySelector('video')!);

    expect(onMediaReady).toHaveBeenLastCalledWith(secondItem);
    expect(onMediaReady).toHaveBeenCalledTimes(2);
  });

  it('reports readiness again when a media id is reused with a refreshed source URL', () => {
    const onMediaReady = vi.fn();
    const initialItem = createVideoItem({ url: 'https://example.com/initial.mp4' });
    const refreshedItem = createVideoItem({ url: 'https://example.com/refreshed.mp4' });
    const { container, rerender } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mode="reel"
        mediaItems={[initialItem]}
        onMediaReady={onMediaReady}
      />
    );

    fireEvent.canPlay(container.querySelector('video')!);
    expect(onMediaReady).toHaveBeenLastCalledWith(initialItem);

    rerender(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mode="reel"
        mediaItems={[refreshedItem]}
        onMediaReady={onMediaReady}
      />
    );
    expect(container.querySelector('video')).toHaveAttribute('src', refreshedItem.url);
    fireEvent.playing(container.querySelector('video')!);

    expect(onMediaReady).toHaveBeenLastCalledWith(refreshedItem);
    expect(onMediaReady).toHaveBeenCalledTimes(2);
  });

  it('reports a failed video as the exact media item and exposes an accessible retry action', () => {
    const onMediaReady = vi.fn();
    const onMediaError = vi.fn();
    const onMediaRetry = vi.fn();
    const mediaItem = createVideoItem();
    const { container } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mode="reel"
        mediaItems={[mediaItem]}
        onMediaReady={onMediaReady}
        onMediaError={onMediaError}
        onMediaRetry={onMediaRetry}
      />
    );
    const video = container.querySelector('video');

    fireEvent.error(video!);

    expect(onMediaError).toHaveBeenCalledWith(mediaItem);
    fireEvent.playing(video!);
    expect(onMediaReady).not.toHaveBeenCalled();
    const retryButton = screen.getByRole('button', { name: 'Retry video' });
    fireEvent.click(retryButton);

    expect(onMediaRetry).toHaveBeenCalledWith(mediaItem);
    expect(screen.queryByRole('button', { name: 'Retry video' })).not.toBeInTheDocument();
  });

  it('turns a reel video that never becomes ready into a bounded, retryable error', () => {
    vi.useFakeTimers();
    const onMediaError = vi.fn();
    const mediaItem = createVideoItem();
    const { unmount } = render(
      <ShowcaseMediaCarousel
        title="Campaign clip"
        mode="reel"
        mediaItems={[mediaItem]}
        onMediaError={onMediaError}
      />
    );

    try {
      act(() => {
        vi.advanceTimersByTime(15_000);
      });

      expect(onMediaError).toHaveBeenCalledWith(mediaItem);
      expect(screen.getByRole('button', { name: 'Retry video' })).toBeInTheDocument();
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  describe('feed renditions', () => {
    const RENDITION = 'https://example.com/clip.feed.abc123.mp4';

    function playInFeed(item: ShowcaseMediaItem) {
      const { container } = render(
        <ShowcaseMediaCarousel title="Campaign clip" autoPlayVideo mediaItems={[item]} />
      );
      act(() => {
        getPlaybackObserver()?.callback([
          { isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry,
        ], {} as IntersectionObserver);
      });
      return container.querySelector('video');
    }

    it('streams the small rendition instead of the source', () => {
      // The whole point of the pipeline: scroll-by playback is muted, so it does
      // not need the full-quality source, and the source is what costs egress.
      expect(playInFeed(createVideoItem({ renditionUrl: RENDITION })))
        .toHaveAttribute('src', RENDITION);
    });

    it('falls back to the source when no rendition exists yet', () => {
      expect(playInFeed(createVideoItem()))
        .toHaveAttribute('src', 'https://example.com/clip.mp4');
    });

    it('falls back to the source when the rendition is explicitly null', () => {
      expect(playInFeed(createVideoItem({ renditionUrl: null })))
        .toHaveAttribute('src', 'https://example.com/clip.mp4');
    });

    it('reads the rendition off the media descriptor too', () => {
      // post-media.ts populates both the top-level field and the descriptor;
      // mobile prefers the descriptor, so web must resolve it the same way.
      const item = createVideoItem({
        preview: {
          id: 'video-1',
          kind: 'video',
          url: 'https://example.com/clip.mp4',
          renditionUrl: RENDITION,
          previewUrl: null,
          thumbhash: null,
          cacheKey: 'video-1',
          expiresAt: null,
          width: 1080,
          height: 1350,
          durationSeconds: 8,
          status: 'ready',
          gridReady: false,
        },
      });
      expect(playInFeed(item)).toHaveAttribute('src', RENDITION);
    });

    it('streams the rendition in reel and detail modes too', () => {
      // These play unmuted at full size and used to insist on the source for
      // quality. The 2026-08 scaling audit measured that preference as the
      // bulk of all storage egress -- ~23 Mbps a stream against a 720p/1.4
      // Mbps rendition -- so every playback surface now takes the rendition.
      // `url` remains the source of record for downloads and remixes.
      for (const mode of ['reel', 'detail'] as const) {
        const { container, unmount } = render(
          <ShowcaseMediaCarousel
            title="Campaign clip"
            mode={mode}
            mediaItems={[createVideoItem({ renditionUrl: RENDITION })]}
          />
        );
        expect(container.querySelector('video')).toHaveAttribute('src', RENDITION);
        unmount();
      }
    });

    it('falls back to the source in reel and detail when no rendition exists', () => {
      for (const mode of ['reel', 'detail'] as const) {
        const { container, unmount } = render(
          <ShowcaseMediaCarousel
            title="Campaign clip"
            mode={mode}
            mediaItems={[createVideoItem({ renditionUrl: null })]}
          />
        );
        expect(container.querySelector('video'))
          .toHaveAttribute('src', 'https://example.com/clip.mp4');
        unmount();
      }
    });

    it('still attaches nothing until the card is on screen', () => {
      const { container } = render(
        <ShowcaseMediaCarousel
          title="Campaign clip"
          autoPlayVideo
          mediaItems={[createVideoItem({ renditionUrl: RENDITION })]}
        />
      );
      expect(container.querySelector('video')).not.toHaveAttribute('src');
    });

    it('remounts cleanly when a rendition backfills mid-session', () => {
      // The load key is derived from the played URL. Keying on the source alone
      // would leave a terminal error from the old element attached to what is
      // now a different source, sticking the error overlay open.
      const { container, rerender } = render(
        <ShowcaseMediaCarousel
          title="Campaign clip"
          autoPlayVideo
          mediaItems={[createVideoItem()]}
        />
      );
      act(() => {
        getPlaybackObserver()?.callback([
          { isIntersecting: true, intersectionRatio: 0.7 } as IntersectionObserverEntry,
        ], {} as IntersectionObserver);
      });
      expect(container.querySelector('video'))
        .toHaveAttribute('src', 'https://example.com/clip.mp4');

      rerender(
        <ShowcaseMediaCarousel
          title="Campaign clip"
          autoPlayVideo
          mediaItems={[createVideoItem({ renditionUrl: RENDITION })]}
        />
      );
      expect(container.querySelector('video')).toHaveAttribute('src', RENDITION);
    });
  });
});
