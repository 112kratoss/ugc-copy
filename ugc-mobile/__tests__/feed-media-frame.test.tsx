import { buildMediaSource } from '../lib/media-source';
import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('@/lib/use-media-source', () => ({
  useMediaSource: (url: string) => ({ source: buildMediaSource(url, 'https://magicbooklet.com', 'test-session'), requestKey: '' }),
}));

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
  it('keeps preview and original identities separate across signed URL renewal', () => {
    let tree: renderer.ReactTestRenderer;
    const frame = (token: string) => <FeedMediaFrame
      kind="image"
      url={`https://cdn.example.com/original.jpg?token=${token}`}
      backdropUrl={`https://cdn.example.com/preview.webp?token=${token}`}
      cacheKey="asset-v1:source"
      backdropCacheKey="asset-v1:preview"
    />;
    renderer.act(() => { tree = renderer.create(frame('first')); });
    renderer.act(() => { tree.update(frame('renewed')); });
    const images = tree!.root.findAll(node => node.type === 'image');
    expect(images.map(node => node.props.source)).toEqual([
      { uri: 'https://cdn.example.com/preview.webp?token=renewed', cacheKey: 'asset-v1:preview' },
      { uri: 'https://cdn.example.com/original.jpg?token=renewed', cacheKey: 'asset-v1:source' },
    ]);
    renderer.act(() => { tree.unmount(); });
  });

  it('shares the original cache identity when no separate backdrop exists and retains authorization', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<FeedMediaFrame
      kind="image" url="/api/media?path=generated_images%2Fowner%2Fimage.jpg" cacheKey="original-v1"
    />); });
    const images = tree!.root.findAll(node => node.type === 'image');
    expect(images[0].props.source).toEqual({
      uri: 'https://magicbooklet.com/api/media?path=generated_images%2Fowner%2Fimage.jpg',
      headers: { Authorization: 'Bearer test-session' }, cacheKey: 'original-v1',
    });
    expect(images[1].props.source.cacheKey).toBe('original-v1');
    renderer.act(() => { tree.unmount(); });
  });

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

  it('makes the native video frame touch-transparent to its parent press target', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="video"
          player={{ id: 'player-touch' } as never}
          radius={14}
          style={{ height: 300 }}
        />
      );
    });

    const frame = tree!.root.findAll((node) => node.type === 'view')[0];
    expect(frame.props.pointerEvents).toBe('none');
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
    expect(posters[0].props.source.cacheKey).toBe('video-2:video-poster');
    expect(posters[1].props.source.cacheKey).toBe('video-2:video-poster');
    expect(posters[1].props.source).toMatchObject({ uri: 'https://cdn.example.com/video-poster.jpg' });
    expect(posters[1].props.contentFit).toBe('contain');
    expect(posters[1].props.blurRadius).toBeUndefined();
    expect(posters[1].props.recyclingKey).toBe('video-2:video-poster');
  });

  it('can render a clean cover video without a blurred backdrop', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <FeedMediaFrame
          kind="video"
          player={{ id: 'player-clean' } as never}
          backdropUrl="https://cdn.example.com/video-poster.jpg"
          posterUrl="https://cdn.example.com/video-poster.jpg"
          posterVisible
          recyclingKey="video-clean"
          videoBackdrop="none"
          videoContentFit="cover"
          style={{ height: 104 }}
        />
      );
    });

    const [video] = tree!.root.findAll((node) => String(node.type) === 'video-view');
    expect(video.props.contentFit).toBe('cover');

    const posters = tree!.root.findAll((node) => node.type === 'image');
    expect(posters).toHaveLength(1);
    expect(posters[0].props.contentFit).toBe('cover');
    expect(posters[0].props.blurRadius).toBeUndefined();
    expect(posters[0].props.recyclingKey).toBe('video-clean:video-poster');
  });
});
