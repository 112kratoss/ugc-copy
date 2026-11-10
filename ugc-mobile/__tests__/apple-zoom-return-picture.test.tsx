(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The tile's half of the picture a close lands on
 * (`useAppleZoomReturnPicture`, `AppleZoomReturnPictureView` in
 * components/apple-zoom.ios.tsx). UIKit's zoom crossfades the closing reel
 * into the view beside the tile; empty, the reel faded out short of the tile
 * (owner, 2026-11-10: "when the image is closing we dont have any animation
 * its just fades"). While a reel holds the tile's picture, that view draws it
 * and the tile hides what it draws itself; when the reel lets go, the view
 * empties and the tile shows again in the same render.
 */

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
}));
vi.mock('expo-router', () => ({
  Link: { AppleZoomTarget: ({ children }: MockProps) => children },
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ addListener: () => () => {} }),
}));
vi.mock('expo-router/build/link/preview/native', () => ({ LinkZoomTransitionSource: ({ children }: MockProps) => children }));
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => true }));

import { AppleZoomReturnPictureView, useAppleZoomReturnPicture, type AppleZoomReturnPicture } from '../components/apple-zoom.ios';
import { holdAppleZoomReturnPicture, releaseAppleZoomReturnPicture, resetAppleZoomReturnPictures } from '../lib/apple-zoom-surface';

const PREVIEW = { url: 'https://example.test/tile.webp', cacheKey: 'tile', thumbhash: null };

let seen!: AppleZoomReturnPicture;

function Tile({ itemId = 'post-1', preview = PREVIEW }: { itemId?: string; preview?: typeof PREVIEW | null }) {
  const returnPicture = useAppleZoomReturnPicture(':r1:', itemId, preview);
  seen = returnPicture;
  return <AppleZoomReturnPictureView identifier={`zoom|:r1:|${itemId}`} returnPicture={returnPicture} radius={16} />;
}

const mounted: renderer.ReactTestRenderer[] = [];

function mountTile(element: React.ReactElement = <Tile />) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  mounted.push(tree);
  return tree;
}

/** The image view UIKit's zoom is given. */
const image = (tree: renderer.ReactTestRenderer) => tree.root.findByType('image' as never);
/** The view reports that it has drawn its picture, as expo-image does. */
const draw = (tree: renderer.ReactTestRenderer) => renderer.act(() => {
  (image(tree).props.onDisplay as () => void)();
});

afterEach(() => {
  mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
  resetAppleZoomReturnPictures();
});

describe('the picture a close lands on, at its tile', () => {
  it('is an empty view in the tile\'s corners until a reel holds the tile\'s picture', () => {
    const tree = mountTile();
    expect(image(tree).props.source).toBeNull();
    expect(image(tree).props.recyclingKey).toBeNull();
    expect(seen.covers).toBe(false);
    const style = Object.assign({}, ...(image(tree).props.style as object[]));
    expect(style).toMatchObject({ position: 'absolute', inset: 0, borderRadius: 16, borderCurve: 'continuous' });
    // Never in the way of the tile's own press.
    expect(image(tree).props.pointerEvents).toBe('none');
  });

  it('draws the tile\'s picture while a reel holds it, and stands in for the tile once it has drawn', () => {
    const tree = mountTile();
    renderer.act(() => holdAppleZoomReturnPicture(':r1:', 'post-1'));
    // The tile's own rendition, under its cache key: in memory already.
    expect(image(tree).props.source).toEqual({ uri: PREVIEW.url, cacheKey: 'tile' });
    expect(image(tree).props.contentFit).toBe('cover');
    expect(image(tree).props.transition).toBe(0);
    // Not drawn yet: the tile keeps drawing itself, or its place would be empty.
    expect(seen.covers).toBe(false);

    draw(tree);
    expect(seen.covers).toBe(true);
  });

  it('empties and gives the tile back in one render when the reel lets go', () => {
    const tree = mountTile();
    renderer.act(() => holdAppleZoomReturnPicture(':r1:', 'post-1'));
    draw(tree);
    const heldKey = image(tree).props.recyclingKey;
    expect(heldKey).toEqual(expect.any(String));

    renderer.act(() => releaseAppleZoomReturnPicture(':r1:', 'post-1', false));
    expect(seen.covers).toBe(false);
    expect(image(tree).props.source).toBeNull();
    // expo-image keeps its last picture when its source goes; the key changing is what clears it.
    expect(image(tree).props.recyclingKey).toBeNull();

    // UIKit puts the view back at the tile's size, and the view reports a draw: of nothing.
    draw(tree);
    expect(seen.covers).toBe(false);
  });

  it('has to draw again before it stands in for the tile a second time', () => {
    const tree = mountTile();
    renderer.act(() => holdAppleZoomReturnPicture(':r1:', 'post-1'));
    draw(tree);
    renderer.act(() => releaseAppleZoomReturnPicture(':r1:', 'post-1', false));

    renderer.act(() => holdAppleZoomReturnPicture(':r1:', 'post-1'));
    expect(image(tree).props.source).toEqual({ uri: PREVIEW.url, cacheKey: 'tile' });
    expect(seen.covers).toBe(false);
    draw(tree);
    expect(seen.covers).toBe(true);
  });

  it('is another tile\'s business: only the post the reel names holds one', () => {
    const tree = mountTile(<Tile itemId="post-2" />);
    renderer.act(() => holdAppleZoomReturnPicture(':r1:', 'post-1'));
    expect(image(tree).props.source).toBeNull();
    expect(seen.covers).toBe(false);
  });

  it('is dropped by a list cell that is handed another post', () => {
    const tree = mountTile();
    renderer.act(() => holdAppleZoomReturnPicture(':r1:', 'post-1'));
    draw(tree);
    expect(seen.covers).toBe(true);

    renderer.act(() => tree.update(<Tile itemId="post-7" />));
    expect(image(tree).props.source).toBeNull();
    expect(seen.covers).toBe(false);
  });

  it('holds nothing for a tile with no picture', () => {
    const tree = mountTile(<Tile preview={null} />);
    renderer.act(() => holdAppleZoomReturnPicture(':r1:', 'post-1'));
    expect(image(tree).props.source).toBeNull();
    draw(tree);
    expect(seen.covers).toBe(false);
  });
});
