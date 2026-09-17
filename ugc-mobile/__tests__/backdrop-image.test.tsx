import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { BackdropImage } from '../components/backdrop-image';
import { resetNativeImageCapabilitiesForTests, setNativeImageCapabilities } from '../lib/media-blur';

const source = { uri: 'https://cdn.example.com/preview.webp', cacheKey: 'asset:preview' };

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

describe('BackdropImage', () => {
  afterEach(() => {
    resetNativeImageCapabilitiesForTests();
    delete process.env.EXPO_OS;
  });

  it('draws the picture from its thumbhash and asks the loader for nothing', () => {
    const tree = render(
      <BackdropImage thumbhash="thumbhash-value" source={source} blurRadius={24} recyclingKey="card:backdrop" style={{ opacity: 1 }} />
    );
    const image = tree.root.findByType('image');
    expect(image.props.placeholder).toEqual({ thumbhash: 'thumbhash-value' });
    expect(image.props.placeholderContentFit).toBe('cover');
    expect(image.props.source).toBeUndefined();
    expect(image.props.blurRadius).toBeUndefined();
    expect(image.props.recyclingKey).toBe('card:backdrop');
    expect(image.props.pointerEvents).toBe('none');
  });

  it('blurs a picture without a thumbhash where the loader can', () => {
    const tree = render(<BackdropImage source={source} blurRadius={24} />);
    const image = tree.root.findByType('image');
    expect(image.props.source).toEqual(source);
    expect(image.props.blurRadius).toBe(24);
    expect(image.props.cachePolicy).toBe('memory-disk');
    expect(image.props.priority).toBe('low');
  });

  it('draws nothing on an Android build whose blur would go through RenderScript', () => {
    process.env.EXPO_OS = 'android';
    expect(render(<BackdropImage source={source} blurRadius={24} />).toJSON()).toBeNull();

    setNativeImageCapabilities({ softwareBlurRadius: true });
    const image = render(<BackdropImage source={source} blurRadius={24} />).root.findByType('image');
    expect(image.props.blurRadius).toBe(24);
  });

  it('still draws the thumbhash on such a build', () => {
    process.env.EXPO_OS = 'android';
    const image = render(<BackdropImage thumbhash="thumbhash-value" source={source} blurRadius={24} />).root.findByType('image');
    expect(image.props.placeholder).toEqual({ thumbhash: 'thumbhash-value' });
  });

  it('draws nothing without a picture to blur', () => {
    expect(render(<BackdropImage source={null} blurRadius={24} />).toJSON()).toBeNull();
    expect(render(<BackdropImage source={{ uri: '' }} blurRadius={24} />).toJSON()).toBeNull();
  });

  it('fills a band with the same picture, thumbhash or blurred', () => {
    const style = { position: 'absolute' as const, width: 10, height: 20, transform: [{ scaleY: -1 }] };
    const fromThumbhash = render(
      <BackdropImage thumbhash="thumbhash-value" source={source} blurRadius={24} contentFit="fill" style={style} />
    ).root.findByType('image');
    expect(fromThumbhash.props.contentFit).toBe('fill');
    expect(fromThumbhash.props.placeholderContentFit).toBe('fill');
    expect(fromThumbhash.props.style).toEqual(style);

    const blurred = render(<BackdropImage source={source} blurRadius={24} contentFit="fill" style={style} />).root.findByType('image');
    expect(blurred.props.contentFit).toBe('fill');
    expect(blurred.props.style).toEqual(style);
  });
});
