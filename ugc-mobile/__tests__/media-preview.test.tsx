// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
const imageState = vi.hoisted(() => ({ prefetch: vi.fn(async () => true) }));

vi.mock('react-native', () => ({
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-image', () => ({
  Image: Object.assign(
    (props: MockProps) => React.createElement('image', props),
    { prefetch: imageState.prefetch }
  ),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

vi.mock('expo-video', () => ({
  useVideoPlayer: () => ({ id: 'player' }),
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

vi.mock('lucide-react-native', () => ({
  ImageOff: (props: MockProps) => React.createElement('image-off', props),
}));

import { StableMediaImage } from '../components/media-preview';

describe('StableMediaImage', () => {
  beforeEach(() => imageState.prefetch.mockClear());

  it('uses stable storage identity and an asset-derived ThumbHash placeholder', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <StableMediaImage
          url="https://signed.example.com/preview.webp?token=one"
          cacheKey="generated_images/user-1/preview.hash.webp"
          thumbhash="thumbhash-base64"
          contentFit="cover"
        />
      );
    });

    const image = tree!.root.findByType('image');
    expect(image.props.source).toEqual({
      uri: 'https://signed.example.com/preview.webp?token=one',
      cacheKey: 'generated_images/user-1/preview.hash.webp',
    });
    expect(image.props.placeholder).toEqual({ thumbhash: 'thumbhash-base64' });
    expect(image.props.recyclingKey).toBe('generated_images/user-1/preview.hash.webp');
    expect(imageState.prefetch).not.toHaveBeenCalled();
  });

  it('resets an errored recycled cell when its stable cache key changes', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/one.webp" cacheKey="one" />);
    });
    renderer.act(() => tree!.root.findByType('image').props.onError());
    expect(tree!.root.findAllByType('image')).toHaveLength(0);

    renderer.act(() => {
      tree!.update(<StableMediaImage url="https://cdn/two.webp" cacheKey="two" />);
    });
    expect(tree!.root.findByType('image').props.recyclingKey).toBe('two');
  });
});
