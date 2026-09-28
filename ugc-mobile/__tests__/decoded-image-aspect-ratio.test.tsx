import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { decodedImageAspectRatio, rememberDecodedImageAspectRatio } from '../lib/decoded-image-aspect-ratio';
import { useDecodedImageAspectRatio } from '../lib/use-decoded-image-aspect-ratio';

function Reader({ url, declared = null }: { url: string; declared?: number | null }) {
  const ratio = useDecodedImageAspectRatio(declared, url);
  return React.createElement('ratio', { value: ratio });
}

describe('decoded image dimensions', () => {
  it('shares a decoded preview between tile and viewer without leaking across recycled items', () => {
    const url = 'test:decoded-preview';
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Reader url={url} />); });
    const value = () => tree.root.findByType('ratio' as never).props.value;
    expect(value()).toBeNull();
    renderer.act(() => rememberDecodedImageAspectRatio(url, 1024, 1024));
    expect(value()).toBe(1);
    renderer.act(() => { tree.update(<Reader url="test:other-image" />); });
    expect(value()).toBeNull();
    renderer.act(() => { tree.update(<Reader url={url} declared={9 / 16} />); });
    expect(value()).toBe(9 / 16);
    renderer.act(() => { tree.unmount(); });
  });

  it('rejects invalid dimensions and bounds the cache', () => {
    const url = 'test:bounded';
    rememberDecodedImageAspectRatio(url, 0, 10);
    rememberDecodedImageAspectRatio(url, NaN, 10);
    rememberDecodedImageAspectRatio(url, 10, Infinity);
    expect(decodedImageAspectRatio(url)).toBeNull();
    rememberDecodedImageAspectRatio(url, 1600, 900);
    expect(decodedImageAspectRatio(url)).toBe(16 / 9);
    for (let i = 0; i < 256; i++) rememberDecodedImageAspectRatio(`test:cache-${i}`, 400, 500);
    expect(decodedImageAspectRatio(url)).toBeNull();
  });
});
