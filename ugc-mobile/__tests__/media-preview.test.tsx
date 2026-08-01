// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
const imageState = vi.hoisted(() => ({ prefetch: vi.fn(async () => true) }));

vi.mock('react-native', () => ({
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
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

// Fires onError and advances timers until the failure latches, so these tests
// hold for the never-retry placeholder policy and any bounded auto-retry
// policy in imageRetryDelayMs alike.
function exhaustImageLoad(tree: renderer.ReactTestRenderer) {
  for (let guard = 0; guard < 25; guard += 1) {
    // Only images with onError are loading real sources; the failure tile's
    // thumbhash placeholder renders as an <image> without one.
    const images = tree.root
      .findAllByType('image')
      .filter((node) => typeof node.props.onError === 'function');
    if (images.length === 0) return;
    renderer.act(() => images[0].props.onError());
    renderer.act(() => {
      vi.runAllTimers();
    });
  }
  throw new Error('image load never latched failure — is the retry policy unbounded?');
}

describe('StableMediaImage', () => {
  beforeEach(() => {
    imageState.prefetch.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    exhaustImageLoad(tree!);
    expect(tree!.root.findAllByType('image')).toHaveLength(0);

    renderer.act(() => {
      tree!.update(<StableMediaImage url="https://cdn/two.webp" cacheKey="two" />);
    });
    expect(tree!.root.findByType('image').props.recyclingKey).toBe('two');
  });

  it('releases the failure latch when only the url changes (fallback source swap)', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/preview.webp" cacheKey="stable-key" />);
    });
    exhaustImageLoad(tree!);
    expect(tree!.root.findAllByType('image')).toHaveLength(0);

    renderer.act(() => {
      tree!.update(<StableMediaImage url="https://cdn/original.webp" cacheKey="stable-key" />);
    });
    const image = tree!.root.findByType('image');
    expect(image.props.source).toEqual({ uri: 'https://cdn/original.webp', cacheKey: 'stable-key' });
  });

  it('recovers from a latched failure via tap-to-retry', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/one.webp" cacheKey="one" />);
    });
    exhaustImageLoad(tree!);

    renderer.act(() => tree!.root.find((node) => String(node.type) === 'pressable').props.onPress());
    expect(tree!.root.findByType('image').props.source).toEqual({
      uri: 'https://cdn/one.webp',
      cacheKey: 'one',
    });
  });

  it('keeps the thumbhash visible in the failure tile when one exists', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <StableMediaImage url="https://cdn/one.webp" cacheKey="one" thumbhash="thumbhash-base64" />
      );
    });
    exhaustImageLoad(tree!);

    const placeholderImages = tree!.root
      .findAllByType('image')
      .filter((node) => node.props.placeholder?.thumbhash === 'thumbhash-base64' && !node.props.source);
    expect(placeholderImages).toHaveLength(1);
  });
});
