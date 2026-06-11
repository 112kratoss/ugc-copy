import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const videoState = vi.hoisted(() => ({
  player: {
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

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-image', () => ({
  Image: (props: Record<string, unknown>) => React.createElement('image', props),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: Record<string, unknown>) => React.createElement('activity-indicator', props),
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
});
