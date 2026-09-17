import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

import { BAND_BLUR_RADIUS, LetterboxBands } from '../components/letterbox-bands';

// A portrait frame around a landscape picture: a band above and one below.
const frame = { width: 400, height: 800 };
const aspectRatio = 2;

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

describe('LetterboxBands', () => {
  afterEach(() => {
    delete process.env.EXPO_OS;
  });

  it('mirrors the picture into each band from its thumbhash, blurring nothing at draw time', () => {
    const tree = render(
      <LetterboxBands
        frame={frame}
        aspectRatio={aspectRatio}
        source={{ uri: 'https://cdn.example.com/preview.webp', cacheKey: 'asset:preview', thumbhash: 'thumbhash-value' }}
      />
    );
    const images = tree.root.findAllByType('image');
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.props.placeholder).toEqual({ thumbhash: 'thumbhash-value' });
      expect(image.props.source).toBeUndefined();
      expect(image.props.blurRadius).toBeUndefined();
      expect(image.props.contentFit).toBe('fill');
      expect(image.props.style.transform).toEqual([{ scaleY: -1 }]);
    }
    expect(tree.root.findAllByType('linear-gradient' as never)).toHaveLength(2);
  });

  it('blurs a picture without a thumbhash, as the bands always have', () => {
    const tree = render(
      <LetterboxBands
        frame={frame}
        aspectRatio={aspectRatio}
        source={{ uri: 'https://cdn.example.com/preview.webp', cacheKey: 'asset:preview' }}
      />
    );
    const images = tree.root.findAllByType('image');
    expect(images).toHaveLength(2);
    expect(images[0].props.source).toEqual({ uri: 'https://cdn.example.com/preview.webp', cacheKey: 'asset:preview' });
    expect(images[0].props.blurRadius).toBe(BAND_BLUR_RADIUS);
  });

  it('keeps only the shade on an Android build that cannot blur safely', () => {
    process.env.EXPO_OS = 'android';
    const tree = render(
      <LetterboxBands
        frame={frame}
        aspectRatio={aspectRatio}
        source={{ uri: 'https://cdn.example.com/preview.webp', cacheKey: 'asset:preview' }}
      />
    );
    expect(tree.root.findAllByType('image')).toHaveLength(0);
    expect(tree.root.findAllByType('linear-gradient' as never)).toHaveLength(2);
  });

  it('draws only the shade without a picture and nothing for a picture of unknown shape', () => {
    const shadeOnly = render(<LetterboxBands frame={frame} aspectRatio={aspectRatio} source={null} />);
    expect(shadeOnly.root.findAllByType('image')).toHaveLength(0);
    expect(shadeOnly.root.findAllByType('linear-gradient' as never)).toHaveLength(2);

    const unknown = render(
      <LetterboxBands frame={frame} aspectRatio={null} source={{ uri: 'https://cdn.example.com/preview.webp', thumbhash: 'th' }} />
    );
    expect(unknown.toJSON()).toBeNull();
  });
});
