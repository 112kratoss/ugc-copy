import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
const motion = vi.hoisted(() => ({ reduced: false }));
const animations = vi.hoisted(() => ({ timings: [] as unknown[][], repeats: [] as unknown[][] }));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => motion.reduced }));
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: { primary: '#ff6b4a' } }) }));
vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('spinner', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
// The suite's Reanimated double, with the animations it is asked for written down.
vi.mock('react-native-reanimated', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const record = (name: 'withTiming' | 'withRepeat', list: unknown[][]) => (...args: unknown[]) => {
    list.push(args);
    return (actual[name] as (...inner: unknown[]) => unknown)(...args);
  };
  return { ...actual, withTiming: record('withTiming', animations.timings), withRepeat: record('withRepeat', animations.repeats) };
});

import { MediaLoadingSparkle, type MediaSparkleState } from '../components/media-loading-sparkle';
import {
  MEDIA_SPARKLE_CLOCK_SPAN_MS,
  MEDIA_SPARKLE_DELAY_MS,
  MEDIA_SPARKLE_FADE_MS,
  MEDIA_SPARKLE_HANDOFF_MS,
  MEDIA_SPARKLE_TRIO,
  sparklePath,
} from '../lib/media-loading-sparkle';

const advance = (ms: number) => renderer.act(() => {
  vi.advanceTimersByTime(ms);
});

function mount(state: MediaSparkleState = 'loading', handoff?: string) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<MediaLoadingSparkle state={state} label="Loading video" handoff={handoff} />);
  });
  return tree;
}

function update(tree: renderer.ReactTestRenderer, state: MediaSparkleState, handoff?: string) {
  renderer.act(() => tree.update(<MediaLoadingSparkle state={state} label="Loading video" handoff={handoff} />));
}

/** The box that fills the parent and measures itself. */
function box(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'view' && typeof node.props.onLayout === 'function')[0];
}

/** The small view at its centre that a screen reader reads. */
function reader(tree: renderer.ReactTestRenderer) {
  return box(tree).findAll((node) => node.type === 'view' && node.props.style?.minWidth === 44)[0];
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
    // Emptied in place: the recording double holds these very arrays.
    animations.timings.length = 0;
    animations.repeats.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a labelled progress bar from the start, and draws only once the wait passes the delay', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    expect(reader(tree).props.accessibilityRole).toBe('progressbar');
    expect(reader(tree).props.accessibilityLabel).toBe('Loading video');
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

  // The review of #914: on the whole screen, the progress bar was what a screen
  // reader found under Back, Mute or a slide's play button.
  it('leaves the rest of the screen to a screen reader: only a small view at the centre is read', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    expect(box(tree).props.accessible).toBeUndefined();
    expect(box(tree).props.accessibilityRole).toBeUndefined();
    expect(box(tree).props.importantForAccessibility).toBe('no');
    expect(reader(tree).props.style).toMatchObject({ minWidth: 44, minHeight: 44 });
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
    expect(reader(tiny).props.accessibilityLabel).toBe('Loading video');
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
    expect(reader(tree).props.accessibilityRole).toBeUndefined();
    expect(reader(tree).props.importantForAccessibility).toBe('no-hide-descendants');

    advance(MEDIA_SPARKLE_FADE_MS - 1);
    expect(sparkles(tree)).toHaveLength(3);
    advance(1);
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('carries on showing when the wait starts again during the fade', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    update(tree, 'ready');
    advance(MEDIA_SPARKLE_FADE_MS / 2);
    update(tree, 'loading');
    expect(sparkles(tree)).toHaveLength(3);
    expect(reader(tree).props.accessibilityRole).toBe('progressbar');
    advance(MEDIA_SPARKLE_FADE_MS);
    expect(sparkles(tree)).toHaveLength(3);
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

  // The review of #914: Reanimated's default follows the phone's Reduce Motion
  // and would jump the clock to its end, every sparkle still and dim.
  it('runs its twinkle clock whatever the phone\'s Reduce Motion says', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    const clock = animations.timings.find(([toValue]) => toValue === MEDIA_SPARKLE_CLOCK_SPAN_MS);
    expect(clock?.[1]).toMatchObject({ duration: MEDIA_SPARKLE_CLOCK_SPAN_MS, reduceMotion: 'never' });
    expect(animations.repeats).toHaveLength(1);
    expect(animations.repeats[0].slice(1)).toEqual([-1, false, undefined, 'never']);
    renderer.act(() => tree.unmount());
  });

  it('carries straight on when the viewer\'s black screen gives way to the post\'s page mid-wait', () => {
    const shell = mount('loading', 'viewer');
    layOut(shell, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(sparkles(shell)).toHaveLength(3);
    renderer.act(() => shell.unmount());

    advance(MEDIA_SPARKLE_HANDOFF_MS - 50);
    const page = mount('loading', 'viewer');
    layOut(page, 390, 844);
    advance(1);
    expect(sparkles(page)).toHaveLength(3);

    // Only the first to start takes it over.
    const another = mount('loading', 'viewer');
    layOut(another, 390, 844);
    advance(1);
    expect(allSparkles(another)).toHaveLength(0);
    renderer.act(() => page.unmount());
    renderer.act(() => another.unmount());
  });

  // The review of #914: a lightbox closed mid-wait hurried on the next clip's
  // sparkles elsewhere, which then flashed for a clip from the cache.
  it('hands over only between loaders of the same hand-off', () => {
    const lightbox = mount();
    layOut(lightbox, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    renderer.act(() => lightbox.unmount());
    const studio = mount();
    layOut(studio, 120, 300);
    advance(1);
    expect(allSparkles(studio)).toHaveLength(0);
    renderer.act(() => studio.unmount());

    const shell = mount('loading', 'viewer');
    layOut(shell, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    renderer.act(() => shell.unmount());
    const other = mount('loading', 'elsewhere');
    layOut(other, 390, 844);
    advance(1);
    expect(allSparkles(other)).toHaveLength(0);
    renderer.act(() => other.unmount());
  });

  it('waits its own delay after sparkles that went with their media, or long ago', () => {
    const first = mount('loading', 'viewer');
    layOut(first, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    update(first, 'ready', 'viewer');
    advance(MEDIA_SPARKLE_FADE_MS);
    renderer.act(() => first.unmount());
    const next = mount('loading', 'viewer');
    layOut(next, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS - 1);
    expect(allSparkles(next)).toHaveLength(0);
    advance(1);
    expect(sparkles(next)).toHaveLength(3);
    renderer.act(() => next.unmount());

    // `next` went mid-wait, but the window has passed by the time another starts.
    advance(MEDIA_SPARKLE_HANDOFF_MS);
    const late = mount('loading', 'viewer');
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
