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

vi.mock('@/components/media-preview', () => ({
  StableMediaImage: ({ url, cacheKey, thumbhash, ...props }: MockProps) => React.createElement('image', {
    ...props,
    source: { uri: url, cacheKey },
    recyclingKey: cacheKey,
    placeholder: thumbhash ? { thumbhash } : undefined,
  }),
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
  it('renders images with a static blurred cover backdrop and contained foreground', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="image"
          url="https://cdn.example.com/wide-image.jpg"
          backdropUrl="https://cdn.example.com/wide-image-preview.webp"
          recyclingKey="media-1"
          radius={18}
          style={{ height: 240 }}
        />
      );
    });

    const images = tree!.root.findAll((node) => node.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].props.contentFit).toBe('cover');
    expect(images[0].props.source).toEqual({ uri: 'https://cdn.example.com/wide-image-preview.webp' });
    expect(images[0].props.blurRadius).toBeGreaterThan(0);
    expect(images[1].props.contentFit).toBe('contain');
    expect(images[1].props.recyclingKey).toBe('media-1:foreground');
    expect(tree!.root.findAll((node) => String(node.type) === 'blur-view')).toHaveLength(0);
  });

  it('can render compact image tiles as one sharp cover image without a blurred backdrop', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="image"
          url="https://cdn.example.com/profile-tile.jpg"
          imageBackdrop="none"
          imageContentFit="cover"
          recyclingKey="profile:media-1"
          radius={12}
          style={{ height: 148 }}
        />
      );
    });

    const images = tree!.root.findAll((node) => node.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toMatchObject({ uri: 'https://cdn.example.com/profile-tile.jpg' });
    expect(images[0].props.contentFit).toBe('cover');
    expect(images[0].props.blurRadius).toBeUndefined();
    expect(images[0].props.recyclingKey).toBe('profile:media-1:foreground');
  });

  it('renders videos with one contained video surface over a static poster', () => {
    const player = { id: 'player-1' };

    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="video"
          player={player as never}
          backdropUrl="https://cdn.example.com/video-poster.jpg"
          radius={14}
          style={{ height: 300 }}
        />
      );
    });

    const videos = tree!.root.findAll((node) => String(node.type) === 'video-view');
    expect(videos).toHaveLength(1);
    expect(videos[0].props.player).toBe(player);
    expect(videos[0].props.contentFit).toBe('contain');
    expect(videos[0].props.surfaceType).toBe('textureView');

    const posters = tree!.root.findAll((node) => node.type === 'image');
    expect(posters).toHaveLength(1);
    expect(posters[0].props.source).toEqual({ uri: 'https://cdn.example.com/video-poster.jpg' });
  });

  it('can keep a sharp video poster above the native player until playback renders', () => {
    const player = { id: 'player-2' };

    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="video"
          player={player as never}
          backdropUrl="https://cdn.example.com/video-poster.jpg"
          posterUrl="https://cdn.example.com/video-poster.jpg"
          posterVisible
          recyclingKey="video-2"
          style={{ height: 300 }}
        />
      );
    });

    const posters = tree!.root.findAll((node) => node.type === 'image');
    expect(posters).toHaveLength(2);
    expect(posters[1].props.source).toMatchObject({ uri: 'https://cdn.example.com/video-poster.jpg' });
    expect(posters[1].props.contentFit).toBe('contain');
    expect(posters[1].props.blurRadius).toBeUndefined();
    expect(posters[1].props.recyclingKey).toBe('video-2:video-poster');
  });
});
