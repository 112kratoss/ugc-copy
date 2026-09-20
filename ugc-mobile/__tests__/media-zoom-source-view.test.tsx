import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  // The layer's own flight is Android's; iOS hands the open to UIKit's zoom (lib/apple-zoom.ts).
  Platform: { OS: 'android' },
  StatusBar: { currentHeight: 0 },
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874 }),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('expo-image', props),
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({ addListener: () => () => {} }),
}));

// The flight layer draws a lent video in a VideoView.
vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

// And shades letterbox bands and the top strip with expo-linear-gradient, which
// vitest cannot parse.
vi.mock('@/components/letterbox-bands', () => ({
  LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props),
}));
vi.mock('@/components/top-scrim', () => ({
  TopScrim: (props: MockProps) => React.createElement('top-scrim', props),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

import { MediaZoomSourceView, useMediaZoomStage, type MediaZoomSource } from '../components/media-zoom';
import { registerZoomSource, setPendingZoomOrigin, clearPendingZoomOrigin } from '../lib/media-zoom-transition';
import { useMediaZoomTileKey } from '../lib/media-zoom-video-offer';

/** Stands in for whatever a tile draws; the wrappers around it are the subject. */
const TileContent = () => React.createElement('tile-content');

const source: MediaZoomSource = {
  ref: { current: null },
  hiddenStyle: { opacity: 1 },
  prepare: () => {},
  capture: (open) => open(null),
  offerVideo: () => () => {},
  tileKey: 'surface\u0000post',
  appleZoomId: null,
};

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style ?? {}) as Record<string, unknown>;
}

/** The animated wrapper (mocked as `animated-view`) and the measured one inside it. */
function wrapperStyles(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  const root = tree.root;
  return {
    outer: flatten(root.findByType('animated-view' as never).props.style),
    inner: flatten(root.findByType('view' as never).props.style),
  };
}

describe('the view a tile hands to the reel', () => {
  it('exits once when a detached source never answers measurement, and ignores its late callback', () => {
    vi.useFakeTimers();
    let answer: ((rect: { x: number; y: number; width: number; height: number } | null) => void) | undefined;
    const unregister = registerZoomSource('timeout-surface', 'timeout-post', {
      radius: 12, aspectRatio: 1, preview: null, setHidden: vi.fn(),
      measure: (callback) => { answer = callback; },
    });
    setPendingZoomOrigin({ surfaceId: 'timeout-surface', itemId: 'timeout-post',
      rect: { x: 10, y: 100, width: 100, height: 100 }, radius: 12,
      aspectRatio: 1, preview: null, flightId: -1, recordedAt: Date.now() });
    const exit = vi.fn();
    let stage!: ReturnType<typeof useMediaZoomStage>;
    function Reader() {
      stage = useMediaZoomStage({ screen: { width: 402, height: 874 },
        initialItemId: 'timeout-post', activeItemId: 'timeout-post', aspectRatio: 1,
        reducedMotion: false, ready: false, expectsNeighbours: false, onExit: exit });
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    try {
      renderer.act(() => { tree = renderer.create(<Reader />); });
      renderer.act(() => stage.dismiss());
      expect(answer).toBeDefined();
      expect(exit).not.toHaveBeenCalled();
      renderer.act(() => { vi.advanceTimersByTime(2000); });
      expect(exit).toHaveBeenCalledTimes(1);
      renderer.act(() => answer?.({ x: 10, y: 100, width: 100, height: 100 }));
      renderer.act(() => { vi.advanceTimersByTime(2000); });
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      renderer.act(() => tree?.unmount());
      unregister(); clearPendingZoomOrigin(); vi.useRealTimers();
    }
  });
  /**
   * Profile tiles are `flex: 1` inside a cell their parent has already sized,
   * so a wrapper that takes its size from its content collapses them to
   * nothing — which is what the first cut of this shipped. Both wrappers grow
   * into a slot they are given, and take their content's size when they are
   * given none.
   */
  it('grows into the space its parent gave it, and never imposes a size', () => {
    const { outer, inner } = wrapperStyles(
      <MediaZoomSourceView source={source}>
        <TileContent />
      </MediaZoomSourceView>
    );

    for (const style of [outer, inner]) {
      expect(style.flexGrow).toBe(1);
      expect(style.flexBasis).toBe('auto');
      expect(style.width).toBeUndefined();
      expect(style.height).toBeUndefined();
    }
  });

  it("lets the caller's own style win, so a tile can still pin its rectangle", () => {
    const { outer } = wrapperStyles(
      <MediaZoomSourceView source={source} style={{ width: 180, height: 240 }}>
        <TileContent />
      </MediaZoomSourceView>
    );

    expect(outer.width).toBe(180);
    expect(outer.height).toBe(240);
    // And the tile still hides while the reel stands in for it.
    expect(outer.opacity).toBe(1);
  });

  it('tells the video inside it which tile it is, so a closing reel can hand its player back', () => {
    let seen: string | null = null;
    const Reader = () => {
      seen = useMediaZoomTileKey();
      return null;
    };
    renderer.act(() => {
      renderer.create(
        <MediaZoomSourceView source={source}>
          <Reader />
        </MediaZoomSourceView>
      );
    });

    expect(seen).toBe('surface\u0000post');
  });
});
