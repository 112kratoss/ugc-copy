import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const videoState = vi.hoisted(() => ({
  player: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    play: vi.fn(),
    pause: vi.fn(),
    loop: false,
    muted: false,
    volume: 1,
    showNowPlayingNotification: true,
    staysActiveInBackground: true,
    bufferOptions: undefined as { preferredForwardBufferDuration?: number } | undefined,
  },
  useVideoPlayer: vi.fn(),
}));

vi.mock('expo-video', () => ({
  useVideoPlayer: (url: string, setup?: (player: typeof videoState.player) => void) => {
    videoState.useVideoPlayer(url);
    setup?.(videoState.player);
    return videoState.player;
  },
  VideoView: (props: Record<string, unknown>) => React.createElement('video-view', props),
}));

// Counts mounts, not renders: the poster must survive activation flips, and a
// remount is exactly what replays the 120ms transition that reads as flicker.
const imageState = vi.hoisted(() => ({ mounts: 0 }));

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
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: Record<string, unknown>) => React.createElement('activity-indicator', props),
  Text: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('text', props, children),
  View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('view', props, children),
}));

vi.mock('@/lib/theme', () => ({
  appTheme: {
    colors: {
      background: '#03040d',
    },
  },
}));

import { FeedVideoPreview } from '../components/feed-video-preview';

describe('FeedVideoPreview', () => {
  beforeEach(() => {
    videoState.player.addListener.mockClear();
    videoState.player.play.mockClear();
    videoState.player.pause.mockClear();
    videoState.useVideoPlayer.mockClear();
    videoState.player.loop = false;
    videoState.player.muted = false;
    videoState.player.volume = 1;
    videoState.player.showNowPlayingNotification = true;
    videoState.player.staysActiveInBackground = true;
    videoState.player.bufferOptions = undefined;
    imageState.mounts = 0;
  });

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

  it('does not touch the released video player during unmount', () => {
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
    expect(videoState.useVideoPlayer).toHaveBeenCalledTimes(1);
    expect(videoState.player.pause).not.toHaveBeenCalled();

    const videoViews = (tree as renderer.ReactTestRenderer).root.findAll((node) => String(node.type) === 'video-view');
    expect(videoViews.some((node) => node.props.contentFit === 'contain')).toBe(true);

    renderer.act(() => {
      tree!.unmount();
    });

    expect(videoState.player.pause).not.toHaveBeenCalled();
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

    expect(videoState.useVideoPlayer).not.toHaveBeenCalled();
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
    expect(videoState.useVideoPlayer).not.toHaveBeenCalled();
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

    expect(videoState.useVideoPlayer).not.toHaveBeenCalled();
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
    // lifecycle, unlike the `useVideoPlayer` hook, which also fires on the
    // extra render that the deferred unmount deliberately performs.
    expect(videoState.player.play).toHaveBeenCalledTimes(2);
    // ...but the poster underneath never remounted, so it never re-faded.
    expect(imageState.mounts).toBe(1);
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
});
