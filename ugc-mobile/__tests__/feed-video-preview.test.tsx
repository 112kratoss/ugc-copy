import { buildMediaSource } from '../lib/media-source';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const videoState = vi.hoisted(() => ({
  player: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    play: vi.fn(),
    pause: vi.fn(),
    release: vi.fn(),
    loop: false,
    muted: false,
    volume: 1,
    showNowPlayingNotification: true,
    staysActiveInBackground: true,
    bufferOptions: undefined as { preferredForwardBufferDuration?: number } | undefined,
    status: undefined as string | undefined,
  },
  createVideoPlayer: vi.fn(),
}));

vi.mock('@/lib/use-media-source', () => ({
  useMediaSource: (url: string) => ({ source: buildMediaSource(url, 'https://magicbooklet.com', 'test-session'), requestKey: authRevision.current }),
}));

vi.mock('expo-video', () => ({
  createVideoPlayer: (source: unknown) => {
    videoState.createVideoPlayer(source);
    return videoState.player;
  },
  VideoView: (props: Record<string, unknown>) => React.createElement('video-view', props),
}));

// Counts mounts, not renders: the poster must survive activation flips, and a
// remount is exactly what replays the 120ms transition that reads as flicker.
const imageState = vi.hoisted(() => ({ mounts: 0 }));
const authRevision = vi.hoisted(() => ({ current: '' }));
const focusState = vi.hoisted(() => ({ focused: true }));
const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: [] as Array<(state: string) => void>,
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => focusState.focused }));

vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: Record<string, unknown>) => React.createElement('video-preview', props),
}));

vi.mock('expo-image', () => ({
  Image: Object.assign(
    (props: Record<string, unknown>) => {
      React.useEffect(() => {
        imageState.mounts += 1;
      }, []);
      return React.createElement('image', props);
    },
    { prefetch: vi.fn(async () => true) }
  ),
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('lucide-react-native', () => ({
  ImageOff: (props: Record<string, unknown>) => React.createElement('image-off', props),
  Play: (props: Record<string, unknown>) => React.createElement('play-icon', props),
  RotateCcw: (props: Record<string, unknown>) => React.createElement('rotate-icon', props),
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return {
        remove: () => {
          appState.listeners = appState.listeners.filter((entry) => entry !== listener);
        },
      };
    },
  },
  Pressable: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('pressable', props, children),
  ActivityIndicator: (props: Record<string, unknown>) => React.createElement('activity-indicator', props),
  Text: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('text', props, children),
  View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('view', props, children),
}));

import { FeedVideoPreview } from '../components/feed-video-preview';
import { MEDIA_DISPLAY_DEADLINE_MS } from '../lib/media-recovery';

describe('FeedVideoPreview', () => {
  beforeEach(() => {
    authRevision.current = '';
    focusState.focused = true;
    videoState.player.addListener.mockClear();
    videoState.player.play.mockClear();
    videoState.player.pause.mockClear();
    videoState.player.release.mockClear();
    videoState.createVideoPlayer.mockClear();
    videoState.player.loop = false;
    videoState.player.muted = false;
    videoState.player.volume = 1;
    videoState.player.showNowPlayingNotification = true;
    videoState.player.staysActiveInBackground = true;
    videoState.player.bufferOptions = undefined;
    videoState.player.status = undefined;
    imageState.mounts = 0;
    appState.currentState = 'active';
    appState.listeners = [];
  });

  function findRetry(tree: renderer.ReactTestRenderer) {
    return tree.root.findAll((node) => (
      String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Video couldn’t load. Retry'
    ));
  }

  function setAppState(state: string) {
    appState.currentState = state;
    renderer.act(() => {
      appState.listeners.forEach((listener) => listener(state));
    });
  }

  const posterProps = {
    url: 'https://cdn.example.com/video.mp4',
    // The decided feed stream, passed explicitly: `url` alone never plays.
    streamUrl: 'https://cdn.example.com/video.feed.abc.mp4',
    previewUrl: 'https://cdn.example.com/video-poster.jpg',
    height: 260,
    radius: 8,
    accent: '#d946ef',
    videoBackdrop: 'none' as const,
  };

  function posterOpacity(tree: renderer.ReactTestRenderer) {
    const [poster] = tree.root.findAll((node) => String(node.type) === 'image');
    const style = [poster.props.style].flat(2) as Array<Record<string, unknown> | undefined>;
    return style.reduce<number | undefined>(
      (found, entry) => (entry && 'opacity' in entry ? (entry.opacity as number) : found),
      undefined
    );
  }

  it('authenticates a private stream and restores its poster when credentials renew', () => {
    let tree: renderer.ReactTestRenderer;
    const props = { url: 'https://magicbooklet.com/api/media?path=video.mp4',
      streamUrl: 'https://magicbooklet.com/api/media?path=video.mp4',
      previewUrl: 'https://cdn.example.com/poster.webp', active: true, height: 300, radius: 10, accent: '#fff' };
    renderer.act(() => { tree = renderer.create(<FeedVideoPreview {...props} />); });
    expect(videoState.createVideoPlayer).toHaveBeenCalledWith({ uri: props.streamUrl,
      useCaching: true, headers: { Authorization: 'Bearer test-session' } });
    renderer.act(() => tree.root.findByType('video-view' as never).props.onFirstFrameRender());
    authRevision.current = 'renewed';
    renderer.act(() => tree.update(<FeedVideoPreview {...props} />));
    const poster = tree!.root.findAllByType('image').find(node => node.props.onError);
    expect(poster?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 1 })]));
    renderer.act(() => tree.unmount());
  });

  it('pauses before releasing the video player after native detach', () => {
    vi.useFakeTimers();
    let tree: { unmount: () => void } | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedVideoPreview
          url="https://cdn.example.com/video.mp4"
          streamUrl="https://cdn.example.com/video.feed.abc.mp4"
          active
          height={260}
          radius={8}
          accent="#d946ef"
        />
      );
    });

    expect(videoState.player.play).toHaveBeenCalledTimes(1);
    expect(videoState.createVideoPlayer).toHaveBeenCalledTimes(1);
    expect(videoState.player.pause).not.toHaveBeenCalled();

    const videoViews = (tree as renderer.ReactTestRenderer).root.findAll((node) => String(node.type) === 'video-view');
    expect(videoViews.some((node) => node.props.contentFit === 'contain')).toBe(true);

    renderer.act(() => {
      tree!.unmount();
    });

    expect(videoState.player.pause).toHaveBeenCalledTimes(1);
    expect(videoState.player.release).not.toHaveBeenCalled();
    renderer.act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(videoState.player.release).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('renders a poster without creating a player while inactive', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedVideoPreview
          url="https://cdn.example.com/video.mp4"
          previewUrl="https://cdn.example.com/video-poster.jpg"
          active={false}
          height={260}
          radius={8}
          accent="#d946ef"
        />
      );
    });

    expect(videoState.createVideoPlayer).not.toHaveBeenCalled();
    expect(tree!.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
    const images = tree!.root.findAll((node) => String(node.type) === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].props.contentFit).toBe('cover');
  });

  it('never streams the raw source: active without a decided stream stays a poster', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedVideoPreview
          url="https://cdn.example.com/huge-source.mp4"
          streamUrl={null}
          previewUrl="https://cdn.example.com/video-poster.jpg"
          active
          height={260}
          radius={8}
          accent="#d946ef"
        />
      );
    });

    // The old `renditionUrl || url` fallback would have streamed the source
    // here — the exact egress amplifier the feed-stream policy removes.
    expect(videoState.createVideoPlayer).not.toHaveBeenCalled();
    expect(tree!.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
    const images = tree!.root.findAll((node) => String(node.type) === 'image');
    expect(images).toHaveLength(1);
  });

  it('does not mount a video player while an inactive poster is unavailable', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedVideoPreview
          url="https://cdn.example.com/video-without-poster.mp4"
          previewUrl={null}
          active={false}
          height={260}
          radius={8}
          accent="#d946ef"
        />
      );
    });

    expect(videoState.createVideoPlayer).not.toHaveBeenCalled();
    expect(videoState.player.play).not.toHaveBeenCalled();
    const videoViews = tree!.root.findAll((node) => String(node.type) === 'video-view');
    expect(videoViews).toHaveLength(0);
    expect(tree!.root.findAll((node) => String(node.type) === 'play-icon')).toHaveLength(1);
  });

  it('supports the clean cover presentation used by the Showcase feed', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedVideoPreview
          url="https://cdn.example.com/landscape-video.mp4"
          streamUrl="https://cdn.example.com/landscape-video.feed.abc.mp4"
          previewUrl="https://cdn.example.com/landscape-poster.jpg"
          active
          height={104}
          radius={8}
          accent="#fb7185"
          videoBackdrop="none"
          videoContentFit="cover"
        />
      );
    });

    const [video] = tree!.root.findAll((node) => String(node.type) === 'video-view');
    expect(video.props.contentFit).toBe('cover');
    const images = tree!.root.findAll((node) => String(node.type) === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].props.contentFit).toBe('cover');
    expect(images[0].props.blurRadius).toBeUndefined();
  });

  it('caps how far ahead a feed preview buffers', () => {
    renderer.act(() => {
      renderer.create(<FeedVideoPreview {...posterProps} active />);
    });

    // Without this the player takes ExoPlayer's 20s Android default, so one
    // glance at a long clip whose rendition failed downloads 20s of source.
    expect(videoState.player.bufferOptions).toEqual({ preferredForwardBufferDuration: 8 });
    expect(videoState.player.muted).toBe(true);
  });

  it('keeps the poster mounted across activation handoffs', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active={false} />);
    });
    expect(imageState.mounts).toBe(1);

    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active />);
    });
    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active={false} />);
    });
    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active />);
    });

    // Two activations started playback twice — `play` runs once per player
    // lifecycle, without recreating the poster beneath it.
    expect(videoState.player.play).toHaveBeenCalledTimes(2);
    // ...but the poster underneath never remounted, so it never re-faded.
    expect(imageState.mounts).toBe(1);
  });

  it('pauses on tab blur without changing the feed activation and resumes on return', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<FeedVideoPreview {...posterProps} active />); });
    focusState.focused = false;
    renderer.act(() => { tree.update(<FeedVideoPreview {...posterProps} active />); });
    expect(videoState.player.pause).toHaveBeenCalledTimes(1);
    expect(tree!.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
    focusState.focused = true;
    renderer.act(() => { tree.update(<FeedVideoPreview {...posterProps} active />); });
    expect(videoState.player.play).toHaveBeenCalledTimes(2);
    expect(imageState.mounts).toBe(1);
    renderer.act(() => tree.unmount());
  });

  it('pauses the player before unmounting it on deactivation', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active />);
    });
    expect(tree!.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(1);

    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active={false} />);
    });

    expect(videoState.player.pause).toHaveBeenCalledTimes(1);
    expect(tree!.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
  });

  it('hides the poster once the first frame lands and restores it on deactivation', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active />);
    });
    expect(posterOpacity(tree!)).toBe(1);

    const [video] = tree!.root.findAll((node) => String(node.type) === 'video-view');
    renderer.act(() => {
      video.props.onFirstFrameRender();
    });
    expect(posterOpacity(tree!)).toBe(0);
    expect(tree!.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(0);

    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active={false} />);
    });
    expect(posterOpacity(tree!)).toBe(1);
  });

  it('falls back to the poster when playback reports an error', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active />);
    });

    const [video] = tree!.root.findAll((node) => String(node.type) === 'video-view');
    renderer.act(() => {
      video.props.onFirstFrameRender();
    });
    expect(posterOpacity(tree!)).toBe(0);

    const [, statusListener] = videoState.player.addListener.mock.calls.at(-1) as unknown as [
      string,
      (event: { status: string }) => void,
    ];
    renderer.act(() => {
      statusListener({ status: 'error' });
    });

    expect(posterOpacity(tree!)).toBe(1);
    // The spinner is for "still loading", not "failed" — an error must not spin.
    expect(tree!.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(0);
  });

  it('catches a failure reported before the tile subscribed, and retries only its own player', () => {
    videoState.player.status = 'error';
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active />);
    });

    // The failed attempt is released; the poster stays with a way to try again.
    expect(tree.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(0);
    expect(findRetry(tree)).toHaveLength(1);

    videoState.player.status = 'idle';
    renderer.act(() => findRetry(tree)[0].props.onPress());

    expect(videoState.createVideoPlayer).toHaveBeenCalledTimes(2);
    expect(tree.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(1);
    expect(findRetry(tree)).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });

  it('stops waiting for a first frame at the deadline and releases the player', () => {
    vi.useFakeTimers();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active />);
    });
    expect(tree.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(1);

    renderer.act(() => {
      vi.advanceTimersByTime(MEDIA_DISPLAY_DEADLINE_MS);
    });

    expect(tree.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
    expect(posterOpacity(tree)).toBe(1);
    expect(findRetry(tree)).toHaveLength(1);
    renderer.act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(videoState.player.release).toHaveBeenCalledTimes(1);

    renderer.act(() => findRetry(tree)[0].props.onPress());
    expect(videoState.createVideoPlayer).toHaveBeenCalledTimes(2);
    renderer.act(() => tree.unmount());
    vi.useRealTimers();
  });

  it('does not count time in the background against the first frame', () => {
    vi.useFakeTimers();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active />);
    });

    setAppState('background');
    renderer.act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(findRetry(tree)).toHaveLength(0);

    setAppState('active');
    renderer.act(() => {
      vi.advanceTimersByTime(MEDIA_DISPLAY_DEADLINE_MS);
    });
    expect(findRetry(tree)).toHaveLength(1);

    renderer.act(() => tree.unmount());
    vi.useRealTimers();
  });

  it('offers no retry on a tile that is not playing', () => {
    videoState.player.status = 'error';
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active={false} />);
    });

    expect(findRetry(tree)).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });

  it('prepares a paused player that draws its first frame before activation', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active={false} prepared />);
    });

    expect(videoState.createVideoPlayer).toHaveBeenCalledTimes(1);
    expect(videoState.player.play).not.toHaveBeenCalled();
    // Waiting, it holds only the head of the clip.
    expect(videoState.player.bufferOptions).toEqual({ preferredForwardBufferDuration: 3 });
    expect(posterOpacity(tree!)).toBe(1);

    renderer.act(() => {
      tree!.root.findByType('video-view' as never).props.onFirstFrameRender();
    });
    // The paused first frame takes over from the poster, which is that frame.
    expect(posterOpacity(tree!)).toBe(0);
    expect(tree!.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(0);
  });

  it('activates a prepared tile by resuming its player, and keeps it when playback moves on', () => {
    vi.useFakeTimers();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active={false} prepared />);
    });
    renderer.act(() => {
      tree!.root.findByType('video-view' as never).props.onFirstFrameRender();
    });

    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active />);
    });
    expect(videoState.createVideoPlayer).toHaveBeenCalledTimes(1);
    expect(videoState.player.play).toHaveBeenCalledTimes(1);
    expect(videoState.player.bufferOptions).toEqual({ preferredForwardBufferDuration: 8 });
    expect(posterOpacity(tree!)).toBe(0);

    // Playback moves to the next card; this one stays prepared, paused on its frame.
    videoState.player.pause.mockClear();
    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active={false} prepared />);
    });
    renderer.act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(videoState.player.pause).toHaveBeenCalledTimes(1);
    expect(videoState.player.release).not.toHaveBeenCalled();
    expect(posterOpacity(tree!)).toBe(0);

    // Scrolling back resumes that same player instead of loading a new one.
    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active />);
    });
    expect(videoState.createVideoPlayer).toHaveBeenCalledTimes(1);
    expect(videoState.player.play).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('releases a prepared player that leaves the window, and a new one redraws before the poster lifts', () => {
    vi.useFakeTimers();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active={false} prepared />);
    });
    renderer.act(() => {
      tree!.root.findByType('video-view' as never).props.onFirstFrameRender();
    });
    expect(posterOpacity(tree!)).toBe(0);

    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active={false} />);
    });
    expect(tree!.root.findAll((node) => String(node.type) === 'video-view')).toHaveLength(0);
    expect(posterOpacity(tree!)).toBe(1);
    renderer.act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(videoState.player.release).toHaveBeenCalledTimes(1);

    // The same stream again: the released player's frame must not lift the
    // poster over a new player that has not drawn anything yet.
    renderer.act(() => {
      tree!.update(<FeedVideoPreview {...posterProps} active={false} prepared />);
    });
    expect(videoState.createVideoPlayer).toHaveBeenCalledTimes(2);
    expect(posterOpacity(tree!)).toBe(1);
    vi.useRealTimers();
  });

  it('does not dim an activating tile, and shows a spinner only for a slow start', () => {
    vi.useFakeTimers();
    let tree: renderer.ReactTestRenderer | undefined;
    const spinners = () => tree!.root.findAll((node) => String(node.type) === 'activity-indicator');

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active />);
    });
    // A normal start is the poster and then motion, with nothing flashed between.
    expect(spinners()).toHaveLength(0);
    expect(posterOpacity(tree!)).toBe(1);

    renderer.act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(spinners()).toHaveLength(0);
    renderer.act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(spinners()).toHaveLength(1);

    renderer.act(() => {
      tree!.root.findByType('video-view' as never).props.onFirstFrameRender();
    });
    expect(spinners()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('never shows the slow-start spinner on a prepared tile that is not playing', () => {
    vi.useFakeTimers();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<FeedVideoPreview {...posterProps} active={false} prepared />);
    });
    renderer.act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(tree!.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(0);
    vi.useRealTimers();
  });
});
