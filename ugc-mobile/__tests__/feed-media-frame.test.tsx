import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { mediaColors } from '../lib/theme';

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

vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

import { View } from 'react-native';

import { FeedMediaFrame } from '../components/feed-media-frame';

type Node = renderer.ReactTestInstance;

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

/** The plain black layer a contained picture or video sits on. */
function blackGrounds(tree: renderer.ReactTestRenderer): Node[] {
  return tree.root.findAll((node) => {
    if (node.type !== 'view' || node.props.pointerEvents !== 'none') return false;
    const style = flatStyle(node.props.style);
    return style.position === 'absolute' && style.backgroundColor === mediaColors.mediaGround;
  });
}

function images(tree: renderer.ReactTestRenderer): Node[] {
  return tree.root.findAll((node) => node.type === 'image');
}

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

describe('FeedMediaFrame', () => {
  it('keeps the picture’s cache identity across a signed URL renewal', () => {
    let tree!: renderer.ReactTestRenderer;
    const frame = (token: string) => (
      <FeedMediaFrame kind="image" url={`https://cdn.example.com/original.jpg?token=${token}`} cacheKey="asset-v1:source" />
    );
    renderer.act(() => { tree = renderer.create(frame('first')); });
    renderer.act(() => { tree.update(frame('renewed')); });

    expect(images(tree).map((node) => node.props.source)).toEqual([
      { uri: 'https://cdn.example.com/original.jpg?token=renewed', cacheKey: 'asset-v1:source' },
    ]);
    renderer.act(() => { tree.unmount(); });
  });

  it('renders an image contained over plain black, with no second copy of the picture', () => {
    const tree = render(
      <FeedMediaFrame
        kind="image"
        url="https://cdn.example.com/wide-image.jpg"
        recyclingKey="media-1"
        radius={18}
        style={{ height: 240 }}
      />
    );

    const [picture, ...others] = images(tree);
    expect(others).toHaveLength(0);
    expect(picture.props.contentFit).toBe('contain');
    expect(picture.props.recyclingKey).toBe('media-1:foreground');
    expect(picture.props.blurRadius).toBeUndefined();
    expect(blackGrounds(tree)).toHaveLength(1);
  });

  it('can render compact image tiles as one sharp cover image without a backdrop', () => {
    const tree = render(
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

    const found = images(tree);
    expect(found).toHaveLength(1);
    expect(found[0].props.source).toMatchObject({ uri: 'https://cdn.example.com/profile-tile.jpg' });
    expect(found[0].props.contentFit).toBe('cover');
    expect(found[0].props.recyclingKey).toBe('profile:media-1:foreground');
    expect(blackGrounds(tree)).toHaveLength(0);
  });

  it('draws the reel’s letterbox bands in place of the black backdrop when given', () => {
    const tree = render(
      <FeedMediaFrame
        kind="image"
        url="https://cdn.example.com/wide-image.jpg"
        imageBackdropContent={<View testID="letterbox-bands" />}
        style={{ height: 240 }}
      />
    );

    expect(tree.root.findAll((node) => node.type === 'view' && node.props.testID === 'letterbox-bands')).toHaveLength(1);
    expect(blackGrounds(tree)).toHaveLength(0);
  });

  it('renders videos with one contained video surface over plain black', () => {
    const player = { id: 'player-1' };
    const tree = render(<FeedMediaFrame kind="video" player={player as never} radius={14} style={{ height: 300 }} />);

    const videos = tree.root.findAll((node) => String(node.type) === 'video-view');
    expect(videos).toHaveLength(1);
    expect(videos[0].props.player).toBe(player);
    expect(videos[0].props.contentFit).toBe('contain');
    expect(videos[0].props.surfaceType).toBe('textureView');
    expect(images(tree)).toHaveLength(0);
    expect(blackGrounds(tree)).toHaveLength(1);
  });

  it('makes the native video frame touch-transparent to its parent press target', () => {
    const tree = render(<FeedMediaFrame kind="video" player={{ id: 'player-touch' } as never} radius={14} style={{ height: 300 }} />);

    const frame = tree.root.findAll((node) => node.type === 'view')[0];
    expect(frame.props.pointerEvents).toBe('none');
  });

  it('can keep a sharp video poster above the native player until playback renders', () => {
    const tree = render(
      <FeedMediaFrame
        kind="video"
        player={{ id: 'player-2' } as never}
        posterUrl="https://cdn.example.com/video-poster.jpg"
        posterVisible
        recyclingKey="video-2"
        style={{ height: 300 }}
      />
    );

    const posters = images(tree);
    expect(posters).toHaveLength(1);
    expect(posters[0].props.source).toEqual({ uri: 'https://cdn.example.com/video-poster.jpg', cacheKey: 'video-2:video-poster' });
    expect(posters[0].props.contentFit).toBe('contain');
    expect(posters[0].props.blurRadius).toBeUndefined();
  });

  it('can render a clean cover video without a backdrop', () => {
    const tree = render(
      <FeedMediaFrame
        kind="video"
        player={{ id: 'player-clean' } as never}
        posterUrl="https://cdn.example.com/video-poster.jpg"
        posterVisible
        recyclingKey="video-clean"
        videoBackdrop="none"
        videoContentFit="cover"
        style={{ height: 104 }}
      />
    );

    const [video] = tree.root.findAll((node) => String(node.type) === 'video-view');
    expect(video.props.contentFit).toBe('cover');
    const posters = images(tree);
    expect(posters).toHaveLength(1);
    expect(posters[0].props.contentFit).toBe('cover');
    expect(posters[0].props.recyclingKey).toBe('video-clean:video-poster');
    expect(blackGrounds(tree)).toHaveLength(0);
  });

  it('draws the same plain black on Android and iOS', () => {
    for (const os of ['android', 'ios']) {
      process.env.EXPO_OS = os;
      try {
        const tree = render(<FeedMediaFrame kind="image" url="https://cdn.example.com/wide-image.jpg" style={{ height: 240 }} />);
        expect(images(tree)).toHaveLength(1);
        expect(blackGrounds(tree)).toHaveLength(1);
      } finally {
        delete process.env.EXPO_OS;
      }
    }
  });
});
