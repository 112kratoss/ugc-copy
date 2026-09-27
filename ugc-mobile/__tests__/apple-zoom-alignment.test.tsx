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
import { appleZoomAlignmentRect, resetMediaZoomTransitions } from '../lib/media-zoom-transition';

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
  const nativeSource = () => tree.root.findByType('link-zoom-transition-source' as never);
  const layOut = (size: { width: number; height: number }) => {
    const tileView = nativeSource().findByType('view' as never);
    renderer.act(() => {
      tileView.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...size } } });
    });
  };
  return { nativeSource, layOut };
}

describe('a tile under UIKit’s zoom', () => {
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
