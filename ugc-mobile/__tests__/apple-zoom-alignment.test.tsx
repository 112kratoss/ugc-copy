import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * UIKit's zoom asks where to line the tile up with the reel as each transition
 * begins (lib/apple-zoom.ts). Expo Router answers from the reel's
 * `AppleZoomTarget` when it can find it, and from the tile's own alignment
 * otherwise — every push, which begins before the reel's slide has mounted its
 * mark, and every close by Back, which takes the reel out of React before the
 * pop begins. With no alignment UIKit pinned the tile's crop to the top of the
 * reel's screen, and the two pictures slid across each other as the reel shrank.
 * So a tile works the rectangle out from its laid-out size and hands it over.
 *
 * Each tile gives UIKit two views beside it (2026-11-08): one in its own
 * shape, which the closes shrink the reel into, lined up with the picture as
 * above, and a page-shaped one the push grows the reel out of, lined up with
 * the whole screen, so that the zoom's first frame has no offset to get wrong
 * (`appleZoomPageFrame`). Both are empty, but for the first while a reel is
 * showing the tile's still picture, when it draws that picture for the close
 * to land on (2026-11-10, lib/apple-zoom-surface.ts).
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '26.4' },
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
}));
vi.mock('expo-video', () => ({ VideoView: (props: MockProps) => React.createElement('video-view', props) }));
vi.mock('@/components/letterbox-bands', () => ({ LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props) }));
vi.mock('@/components/top-scrim', () => ({ TopScrim: (props: MockProps) => React.createElement('top-scrim', props) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));
vi.mock('expo-router', () => ({
  Link: { AppleZoomTarget: ({ children }: MockProps) => children },
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ addListener: () => () => {}, setParams: () => {} }),
}));
// Expo Router's native source view, as a host element that keeps its props.
vi.mock('expo-router/build/link/preview/native', () => ({
  LinkZoomTransitionSource: ({ children, ...props }: MockProps) =>
    React.createElement('link-zoom-transition-source', props, children),
}));
// The zoom is available: iOS 18 on the bridgeless runtime.
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => true }));
// The iOS bindings, which is what Metro resolves `@/components/apple-zoom` to on an iPhone.
vi.mock('@/components/apple-zoom', () => import('../components/apple-zoom.ios'));

import { MediaZoomSourceView, MediaZoomSurface, useMediaZoomSource } from '../components/media-zoom';
import { parseAppleZoomSourceId } from '../lib/apple-zoom';
import { holdAppleZoomReturnPicture, releaseAppleZoomReturnPicture, resetAppleZoomReturnPictures } from '../lib/apple-zoom-surface';
import { appleZoomAlignmentRect, appleZoomPageFrame, resetMediaZoomTransitions } from '../lib/media-zoom-transition';
import { rememberDecodedImageAspectRatio } from '../lib/decoded-image-aspect-ratio';

const SCREEN = { width: 402, height: 874 };
const PREVIEW = { url: 'https://example.test/tile.webp', cacheKey: 'tile', thumbhash: null };
// The Holi clip (610×1280) and its Home card, which crops it to about 4:5.
const HOLI = 610 / 1280;
const HOME_CARD = { width: 360.67, height: 453.8 };

afterEach(() => {
  resetMediaZoomTransitions();
});

function Tile({ aspectRatio }: { aspectRatio: number | null }) {
  const source = useMediaZoomSource({ itemId: 'post-1', aspectRatio, preview: PREVIEW });
  return (
    <MediaZoomSourceView source={source}>
      <></>
    </MediaZoomSourceView>
  );
}

function mountTile(aspectRatio: number | null) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <MediaZoomSurface>
        <Tile aspectRatio={aspectRatio} />
      </MediaZoomSurface>
    );
  });
  const sources = () => tree.root.findAllByType('link-zoom-transition-source' as never);
  // The view in the tile's own shape, which the closes shrink the reel into.
  const nativeSource = () => {
    const found = sources().filter((node) => !String(node.props.identifier).endsWith('#open'));
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  // The page-shaped view the push grows the reel out of.
  const openSource = () => {
    const found = sources().filter((node) => String(node.props.identifier).endsWith('#open'));
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  // The measured view is the tile's own, beside the views UIKit's zoom is given.
  const tileView = () => tree.root.find((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
  const layOut = (size: { width: number; height: number }) => {
    renderer.act(() => {
      tileView().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...size } } });
    });
  };
  /** The style the tile's own view ends up with. */
  const tileStyle = (): Record<string, unknown> => Object.assign({}, ...(tileView().props.style as (object | null)[]).filter(Boolean));
  return { nativeSource, openSource, layOut, tileStyle };
}

describe('a tile under UIKit’s zoom', () => {
  it('aligns a creation with missing metadata as soon as its preview decodes', () => {
    const { nativeSource, layOut } = mountTile(null);
    layOut(HOME_CARD);
    renderer.act(() => rememberDecodedImageAspectRatio(PREVIEW.url, 1024, 1024));
    expect(nativeSource().props.alignment).toEqual(appleZoomAlignmentRect(SCREEN, 1, HOME_CARD));
  });

  it('hands the zoom the middle of the picture in its own shape once it has been laid out', () => {
    const { nativeSource, layOut } = mountTile(HOLI);
    expect(nativeSource().props.identifier).toMatch(/^zoom\|.+\|post-1$/);
    expect(nativeSource().props.animateAspectRatioChange).toBe(true);
    // Nothing to say before the tile has a size.
    expect(nativeSource().props.alignment).toBeUndefined();

    layOut(HOME_CARD);

    const alignment = nativeSource().props.alignment as { x: number; y: number; width: number; height: number };
    expect(alignment).toEqual(appleZoomAlignmentRect(SCREEN, HOLI, HOME_CARD));
    // Centred on the reel's picture, not pinned to the top of the screen.
    expect(alignment.y + alignment.height / 2).toBeCloseTo(SCREEN.height / 2, 6);
    expect(alignment.y).toBeGreaterThan(180);
  });

  it('grows the reel out of the whole page at the tile\'s scale, lined up with the whole screen', () => {
    const { nativeSource, openSource, layOut } = mountTile(HOLI);
    expect(openSource().props.identifier).toBe(`${nativeSource().props.identifier}#open`);
    layOut(HOME_CARD);
    expect(openSource().props.alignment).toEqual({ x: 0, y: 0, width: SCREEN.width, height: SCREEN.height });
    const frame = appleZoomPageFrame(SCREEN, HOLI, HOME_CARD)!;
    // The page view: the screen's shape, scaled to the tile, the part of its
    // picture the tile shows over the tile.
    const page = openSource().findByType('view' as never);
    expect(page.props.style).toEqual({ position: 'absolute', left: frame.page.x, top: frame.page.y, width: frame.page.width, height: frame.page.height });
    expect(frame.page.width / frame.page.height).toBeCloseTo(SCREEN.width / SCREEN.height, 6);
    const picture = appleZoomAlignmentRect(SCREEN, HOLI, HOME_CARD)!;
    const scale = HOME_CARD.width / picture.width;
    expect(frame.page.x + picture.x * scale).toBeCloseTo(0, 6);
    expect(frame.page.y + picture.y * scale).toBeCloseTo(0, 6);
    expect(frame.tile).toEqual({ x: picture.x * scale, y: picture.y * scale, width: HOME_CARD.width, height: HOME_CARD.height });
  });

  it('gives UIKit views of their own, never the tile with its media', () => {
    const { nativeSource, openSource, layOut } = mountTile(HOLI);
    layOut(HOME_CARD);
    // The view the push grows the reel out of: empty.
    const page = openSource().findAllByType('view' as never);
    expect(page).toHaveLength(1);
    expect(page[0]!.props.children).toBeUndefined();
    expect(page[0]!.props.onLayout).toBeUndefined();
    // The view the closes shrink the reel into: an image view, which fills
    // its bounds as UIKit changes them, with nothing in it while no reel is
    // showing the tile's picture.
    expect(nativeSource().findAllByType('view' as never)).toHaveLength(0);
    const picture = nativeSource().findAllByType('image' as never);
    expect(picture).toHaveLength(1);
    expect(picture[0]!.props.source).toBeNull();
  });

  // The reel's page crossfades into whatever that view draws on its way down.
  // Empty, it faded to nothing short of the tile, and the close read as a fade
  // (owner, 2026-11-10); with the tile's picture in it the picture is there
  // all the way into the tile.
  it('draws the tile\'s picture in the view a close shrinks the reel into while a reel holds it', () => {
    const { nativeSource, layOut, tileStyle } = mountTile(HOLI);
    layOut(HOME_CARD);
    const { surfaceId } = parseAppleZoomSourceId(nativeSource().props.identifier as string)!;
    const picture = () => nativeSource().findByType('image' as never);

    renderer.act(() => holdAppleZoomReturnPicture(surfaceId, 'post-1'));
    expect(picture().props.source).toEqual({ uri: PREVIEW.url, cacheKey: 'tile' });
    // Until it has drawn, the tile goes on drawing itself.
    expect(tileStyle().opacity).toBeUndefined();

    renderer.act(() => (picture().props.onDisplay as () => void)());
    // UIKit takes the view out of the page to fly it: the tile's own picture
    // must not be showing in its place.
    expect(tileStyle().opacity).toBe(0);

    renderer.act(() => releaseAppleZoomReturnPicture(surfaceId, 'post-1', false));
    expect(picture().props.source).toBeNull();
    expect(tileStyle().opacity).toBeUndefined();
    resetAppleZoomReturnPictures();
  });

  it('follows a tile that is laid out again at another size', () => {
    const { nativeSource, layOut } = mountTile(1);
    layOut({ width: 200, height: 200 });
    expect(nativeSource().props.alignment).toEqual(appleZoomAlignmentRect(SCREEN, 1, { width: 200, height: 200 }));

    // A recycled cell showing a wider crop of the same square picture.
    layOut({ width: 200, height: 100 });
    // The square picture sits at y 236, 402×402; its middle 2:1 band is 201 tall.
    expect(nativeSource().props.alignment).toEqual({ x: 0, y: 336.5, width: 402, height: 201 });
  });
});
