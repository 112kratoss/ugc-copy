import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => motion.reduced }));
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: { primary: '#ff6b4a' } }) }));
vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('spinner', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

import { MediaLoadingSparkle, type MediaSparkleState } from '../components/media-loading-sparkle';
import {
  MEDIA_SPARKLE_DELAY_MS,
  MEDIA_SPARKLE_FADE_MS,
  MEDIA_SPARKLE_HANDOFF_MS,
  MEDIA_SPARKLE_TRIO,
  sparklePath,
} from '../lib/media-loading-sparkle';

const advance = (ms: number) => renderer.act(() => {
  vi.advanceTimersByTime(ms);
});

function mount(state: MediaSparkleState = 'loading') {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<MediaLoadingSparkle state={state} label="Loading video" />);
  });
  return tree;
}

function update(tree: renderer.ReactTestRenderer, state: MediaSparkleState) {
  renderer.act(() => tree.update(<MediaLoadingSparkle state={state} label="Loading video" />));
}

/** The box that fills the parent: it measures itself and carries what a screen reader hears. */
function box(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'view' && typeof node.props.onLayout === 'function')[0];
}

function layOut(tree: renderer.ReactTestRenderer, width: number, height: number) {
  renderer.act(() => box(tree).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));
}

/** The sparkles drawn at `scale` of their full size. */
function sparkles(tree: renderer.ReactTestRenderer, scale = 1) {
  const d = sparklePath(MEDIA_SPARKLE_TRIO.arm * scale);
  return tree.root.findAll((node) => node.type === 'path' && node.props.d === d);
}

function allSparkles(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'path');
}

/**
 * Each sparkle's animated style, as the test double resolves it once per
 * render. Its shared values are made afresh on each render, so a fade's
 * progress cannot be read here (`media-loading-sparkle.test.ts` has the maths).
 */
function looks(tree: renderer.ReactTestRenderer) {
  return tree.root.findAllByType('animated-view' as never).map((node) => node.props.style[1]);
}

// Each test an hour after the last, so sparkles one test leaves mid-wait are
// never a hand-off for the next.
let hour = 0;

describe('MediaLoadingSparkle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hour += 1;
    vi.setSystemTime(Date.UTC(2026, 10, 23) + hour * 3_600_000);
    motion.reduced = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a labelled progress bar from the start, and draws only once the wait passes the delay', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    expect(box(tree).props.accessibilityRole).toBe('progressbar');
    expect(box(tree).props.accessibilityLabel).toBe('Loading video');
    expect(box(tree).props.pointerEvents).toBe('none');

    advance(MEDIA_SPARKLE_DELAY_MS - 1);
    expect(allSparkles(tree)).toHaveLength(0);
    advance(1);
    // Three sparkles at full size, the first in the logo's gradient.
    expect(sparkles(tree)).toHaveLength(3);
    expect(sparkles(tree)[0].props.fill).toMatch(/^url\(#sparkleFill/);
    expect(sparkles(tree)[1].props.fill).toBe('#cf8df1');
    expect(sparkles(tree)[2].props.fill).toBe('#fff8ed');
    renderer.act(() => tree.unmount());
  });

  it('draws them smaller in a small player, and keeps the spinner in a box too small for them', () => {
    const small = mount();
    layOut(small, 120, 300);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(sparkles(small, 0.75)).toHaveLength(3);
    renderer.act(() => small.unmount());

    const tiny = mount();
    layOut(tiny, 80, 40);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(tiny.root.findAllByType('spinner' as never)).toHaveLength(1);
    expect(allSparkles(tiny)).toHaveLength(0);
    // The box still says what is happening.
    expect(box(tiny).props.accessibilityLabel).toBe('Loading video');
    renderer.act(() => tiny.unmount());
  });

  it('stays to fade once the media is ready, silent to a screen reader, then goes', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    const drawing = sparkles(tree)[0];

    update(tree, 'ready');
    // The same drawing, not a new one: the fade carries on from the twinkle.
    expect(sparkles(tree)[0]).toBe(drawing);
    expect(box(tree).props.accessibilityRole).toBeUndefined();
    expect(box(tree).props.importantForAccessibility).toBe('no-hide-descendants');

    advance(MEDIA_SPARKLE_FADE_MS - 1);
    expect(sparkles(tree)).toHaveLength(3);
    advance(1);
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('goes at once when the wait ends any other way', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    update(tree, 'gone');
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('never shows for a clip that is ready before the delay passes', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS - 50);
    update(tree, 'ready');
    expect(tree.toJSON()).toBeNull();
    advance(MEDIA_SPARKLE_DELAY_MS * 4);
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('waits the delay again when a new wait starts', () => {
    const tree = mount('ready');
    expect(tree.toJSON()).toBeNull();
    update(tree, 'loading');
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS - 1);
    expect(allSparkles(tree)).toHaveLength(0);
    advance(1);
    expect(sparkles(tree)).toHaveLength(3);
    renderer.act(() => tree.unmount());
  });

  it('twinkles in place under Reduce Motion, and goes without a fade', () => {
    motion.reduced = true;
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(sparkles(tree)).toHaveLength(3);
    looks(tree).forEach((look) => expect(look.transform).toEqual([{ scale: 1 }]));
    update(tree, 'ready');
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('carries straight on when the black screen gives way to the page while the clip is still coming', () => {
    const shell = mount();
    layOut(shell, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(sparkles(shell)).toHaveLength(3);
    renderer.act(() => shell.unmount());

    advance(MEDIA_SPARKLE_HANDOFF_MS - 50);
    const page = mount();
    layOut(page, 390, 844);
    advance(1);
    expect(sparkles(page)).toHaveLength(3);
    renderer.act(() => page.unmount());
  });

  it('waits its own delay after sparkles that went with their media, or long ago', () => {
    const first = mount();
    layOut(first, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    update(first, 'ready');
    advance(MEDIA_SPARKLE_FADE_MS);
    renderer.act(() => first.unmount());
    const next = mount();
    layOut(next, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS - 1);
    expect(allSparkles(next)).toHaveLength(0);
    advance(1);
    expect(sparkles(next)).toHaveLength(3);
    renderer.act(() => next.unmount());

    // `next` went mid-wait, but the window has passed by the time another starts.
    advance(MEDIA_SPARKLE_HANDOFF_MS);
    const late = mount();
    layOut(late, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS - 1);
    expect(allSparkles(late)).toHaveLength(0);
    renderer.act(() => late.unmount());
  });

  it('takes a layout callback with no event, as some suites fire one', () => {
    const tree = mount();
    expect(() => renderer.act(() => box(tree).props.onLayout())).not.toThrow();
    renderer.act(() => tree.unmount());
  });
});
