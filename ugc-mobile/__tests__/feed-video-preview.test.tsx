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

vi.mock('expo-image', () => ({
  Image: Object.assign(
    (props: Record<string, unknown>) => React.createElement('image', props),
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
  });

  it('does not touch the released video player during unmount', () => {
    let tree: { unmount: () => void } | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedVideoPreview
          url="https://cdn.example.com/video.mp4"
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
    expect(images).toHaveLength(2);
    expect(images.some((node) => node.props.contentFit === 'contain')).toBe(true);
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
});
