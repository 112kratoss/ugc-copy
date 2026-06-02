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
}));

vi.mock('expo-video', () => ({
  useVideoPlayer: (_url: string, setup?: (player: typeof videoState.player) => void) => {
    setup?.(videoState.player);
    return videoState.player;
  },
  VideoView: (props: Record<string, unknown>) => React.createElement('video-view', props),
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: Record<string, unknown>) => React.createElement('activity-indicator', props),
  View: (props: Record<string, unknown>) => React.createElement('view', props),
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
    expect(videoState.player.pause).not.toHaveBeenCalled();

    renderer.act(() => {
      tree!.unmount();
    });

    expect(videoState.player.pause).not.toHaveBeenCalled();
  });
});
