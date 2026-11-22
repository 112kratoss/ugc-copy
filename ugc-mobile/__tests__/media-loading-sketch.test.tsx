import { buildMediaSource } from '../lib/media-source';
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: [] as Array<(state: string) => void>,
}));
const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: MockProps) => React.createElement('video-preview', props),
}));

vi.mock('@/lib/use-media-source', () => ({
  useMediaSource: (url: string) => ({ source: buildMediaSource(url, 'https://magicbooklet.com', 'test-session'), requestKey: '' }),
}));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => motion.reduced }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return {
        remove: () => {
          appState.listeners = appState.listeners.filter((entry) => entry !== listener);
        },
      };
    },
  },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
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
  Pencil: (props: MockProps) => React.createElement('pencil', props),
  Play: (props: MockProps) => React.createElement('play', props),
}));

import { MediaLoadingSketch } from '../components/media-sketch';
import { StableMediaImage } from '../components/media-preview';
import { MEDIA_DISPLAY_DEADLINE_MS } from '../lib/media-recovery';
import { MEDIA_SKETCH_DELAY_MS } from '../lib/media-sketch';

const advance = (ms: number) => renderer.act(() => {
  vi.advanceTimersByTime(ms);
});

function sketchesIn(tree: renderer.ReactTestRenderer) {
  return tree.root.findAllByType(MediaLoadingSketch);
}

/** Lays the sketch's box out at a size, as the native view would report it. */
function layOut(tree: renderer.ReactTestRenderer, width: number, height: number) {
  const box = tree.root.findAll((node) => node.type === 'view' && typeof node.props.onLayout === 'function')[0];
  renderer.act(() => box.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));
}

describe('StableMediaImage loading sketch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    appState.currentState = 'active';
    appState.listeners = [];
    motion.reduced = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits before drawing, so a picture from the cache never shows a pencil', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/cached.webp" cacheKey="cached" loadingSketch />);
    });

    advance(MEDIA_SKETCH_DELAY_MS - 50);
    renderer.act(() => tree.root.findByType('image').props.onDisplay());
    advance(MEDIA_SKETCH_DELAY_MS * 4);

    expect(sketchesIn(tree)).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });

  it('draws over a picture that keeps the reader waiting, and goes the moment it shows', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/slow.webp" cacheKey="slow" thumbhash="hash" loadingSketch />);
    });

    advance(MEDIA_SKETCH_DELAY_MS - 1);
    expect(sketchesIn(tree)).toHaveLength(0);
    advance(1);
    expect(sketchesIn(tree)).toHaveLength(1);
    // The placeholder stays: the sketch draws over it, not in place of it.
    expect(tree.root.findByType('image').props.placeholder).toEqual({ thumbhash: 'hash' });

    renderer.act(() => tree.root.findByType('image').props.onDisplay());
    expect(sketchesIn(tree)).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });

  it('is off unless the caller asks for it', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/plain.webp" cacheKey="plain" />);
    });

    advance(MEDIA_SKETCH_DELAY_MS * 4);
    expect(sketchesIn(tree)).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });

  it('keeps drawing through a quiet reload, and gives way to the retry plate', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/stuck.webp" cacheKey="stuck" watchdog loadingSketch />);
    });

    advance(MEDIA_DISPLAY_DEADLINE_MS);
    // The first deadline reloads the picture; the pencil is not put back to its wait.
    expect(sketchesIn(tree)).toHaveLength(1);

    // Each deadline is armed after the reload before it, so they pass one at a time.
    advance(MEDIA_DISPLAY_DEADLINE_MS);
    advance(MEDIA_DISPLAY_DEADLINE_MS);
    expect(JSON.stringify(tree.toJSON())).toContain('Taking too long to load');
    expect(sketchesIn(tree)).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });
});

describe('MediaLoadingSketch', () => {
  beforeEach(() => {
    motion.reduced = false;
  });

  it('draws the pencil and its strokes in a box big enough for them', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MediaLoadingSketch />);
    });
    expect(tree.root.findAllByType('pencil' as never)).toHaveLength(0);

    layOut(tree, 72, 72);
    expect(tree.root.findAllByType('pencil' as never)).toHaveLength(1);
    expect(tree.root.findAllByType('path' as never).length).toBeGreaterThanOrEqual(2);
    renderer.act(() => tree.unmount());
  });

  it('leaves a small thumbnail to its placeholder', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MediaLoadingSketch />);
    });

    layOut(tree, 34, 34);
    expect(tree.root.findAllByType('pencil' as never)).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });

  it('shows the finished sketch, still, when the system asks for reduced motion', () => {
    motion.reduced = true;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MediaLoadingSketch />);
    });

    layOut(tree, 200, 200);
    const strokes = tree.root.findAllByType('path' as never);
    for (const stroke of strokes) expect(stroke.props.animatedProps).toMatchObject({ strokeDashoffset: 0, strokeOpacity: 1 });
    renderer.act(() => tree.unmount());
  });
});
