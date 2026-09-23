import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

import { BAND_BLUR_RADIUS, LetterboxBands } from '../components/letterbox-bands';
import { hexWithAlpha } from '../lib/eased-fade';
import { LETTERBOX_EDGE_ALPHA } from '../lib/letterbox';

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

/** The bands' shades: views drawn with React Native's own gradient. */
function shades(tree: renderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.type === 'view' && typeof node.props.style?.experimental_backgroundImage === 'string')
    .map((node) => node.props.style.experimental_backgroundImage);
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
    expect(shades(tree)).toHaveLength(2);
  });

  it('shades each band darkest at its frame edge, running towards the picture', () => {
    // Above and below a landscape picture, then either side of a square one.
    const portrait = shades(render(<LetterboxBands frame={frame} aspectRatio={aspectRatio} source={null} />));
    const landscape = shades(render(<LetterboxBands frame={{ width: 800, height: 400 }} aspectRatio={1} source={null} />));
    expect([...portrait, ...landscape].map((shade) => shade.slice(0, shade.indexOf(',')))).toEqual([
      'linear-gradient(to bottom',
      'linear-gradient(to top',
      'linear-gradient(to right',
      'linear-gradient(to left',
    ]);
    for (const shade of [...portrait, ...landscape]) {
      expect(shade).toContain(`, ${hexWithAlpha('#000000', LETTERBOX_EDGE_ALPHA)} 0%, `);
      expect(shade.endsWith(', #00000000 100%)')).toBe(true);
    }
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
    expect(shades(tree)).toHaveLength(2);
  });

  it('draws only the shade without a picture and nothing for a picture of unknown shape', () => {
    const shadeOnly = render(<LetterboxBands frame={frame} aspectRatio={aspectRatio} source={null} />);
    expect(shadeOnly.root.findAllByType('image')).toHaveLength(0);
    expect(shades(shadeOnly)).toHaveLength(2);

    const unknown = render(
      <LetterboxBands frame={frame} aspectRatio={null} source={{ uri: 'https://cdn.example.com/preview.webp', thumbhash: 'th' }} />
    );
    expect(unknown.toJSON()).toBeNull();
  });
});
