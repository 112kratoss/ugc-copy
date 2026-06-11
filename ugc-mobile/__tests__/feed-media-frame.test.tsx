import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: MockProps) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

import { FeedMediaFrame } from '../components/feed-media-frame';

describe('FeedMediaFrame', () => {
  it('renders images with a blurred cover backdrop and contained foreground', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="image"
          url="https://cdn.example.com/wide-image.jpg"
          radius={18}
          style={{ height: 240 }}
        />
      );
    });

    const images = tree!.root.findAll((node) => node.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].props.contentFit).toBe('cover');
    expect(images[1].props.contentFit).toBe('contain');

    const blur = tree!.root.find((node) => String(node.type) === 'blur-view');
    expect(blur.props.experimentalBlurMethod).toBe('dimezisBlurView');
    expect(blur.props.tint).toBe('dark');
  });

  it('renders videos with one shared player and a contained foreground view', () => {
    const player = { id: 'player-1' };

    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="video"
          player={player as never}
          radius={14}
          style={{ height: 300 }}
        />
      );
    });

    const videos = tree!.root.findAll((node) => String(node.type) === 'video-view');
    expect(videos).toHaveLength(2);
    expect(videos[0].props.player).toBe(player);
    expect(videos[1].props.player).toBe(player);
    expect(videos[0].props.contentFit).toBe('cover');
    expect(videos[1].props.contentFit).toBe('contain');
    expect(videos[0].props.surfaceType).toBe('textureView');
    expect(videos[1].props.surfaceType).toBe('textureView');
  });
});
