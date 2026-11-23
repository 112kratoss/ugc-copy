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
  MEDIA_SPARKLE_BURST_MS,
  MEDIA_SPARKLE_DELAY_MS,
  MEDIA_SPARKLE_HANDOFF_MS,
  MEDIA_SPARKLE_TRIO_FADE_MS,
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

/** The big sparkle: the logo's shape at full size. */
function bigSparkles(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'path' && node.props.d === sparklePath(22));
}

function trioSparkles(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'path' && node.props.d === sparklePath(6));
}

function svgs(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'svg');
}

// Each test an hour after the last, so a sparkle one test leaves mid-wait is
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
    expect(bigSparkles(tree)).toHaveLength(0);
    advance(1);
    expect(bigSparkles(tree)).toHaveLength(1);
    // The glow, the sparkle, its dot, three shed motes and the burst's twelve, ready for the end.
    expect(svgs(tree)).toHaveLength(18);
    renderer.act(() => tree.unmount());
  });

  it('gives a small player the trio, and a box too small for it the spinner', () => {
    const small = mount();
    layOut(small, 170, 300);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(trioSparkles(small)).toHaveLength(3);
    expect(bigSparkles(small)).toHaveLength(0);
    renderer.act(() => small.unmount());

    const tiny = mount();
    layOut(tiny, 48, 30);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(tiny.root.findAllByType('spinner' as never)).toHaveLength(1);
    expect(svgs(tiny)).toHaveLength(0);
    // The box still says what is happening.
    expect(box(tiny).props.accessibilityLabel).toBe('Loading video');
    renderer.act(() => tiny.unmount());
  });

  it('stays for its burst once the media is ready, silent to a screen reader, then goes', () => {
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    const drawing = bigSparkles(tree)[0];

    update(tree, 'ready');
    // The same drawing, not a new one: the burst carries on from the breath.
    expect(bigSparkles(tree)[0]).toBe(drawing);
    expect(box(tree).props.accessibilityRole).toBeUndefined();
    expect(box(tree).props.importantForAccessibility).toBe('no-hide-descendants');

    advance(MEDIA_SPARKLE_BURST_MS - 1);
    expect(bigSparkles(tree)).toHaveLength(1);
    advance(1);
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('fades the trio out as the media comes in', () => {
    const tree = mount();
    layOut(tree, 170, 300);
    advance(MEDIA_SPARKLE_DELAY_MS);
    update(tree, 'ready');
    expect(trioSparkles(tree)).toHaveLength(3);
    advance(MEDIA_SPARKLE_TRIO_FADE_MS);
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
    expect(bigSparkles(tree)).toHaveLength(0);
    advance(1);
    expect(bigSparkles(tree)).toHaveLength(1);
    renderer.act(() => tree.unmount());
  });

  it('under Reduce Motion draws no motes and goes without a burst', () => {
    motion.reduced = true;
    const tree = mount();
    layOut(tree, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(bigSparkles(tree)).toHaveLength(1);
    // The glow, the sparkle and its dot alone.
    expect(svgs(tree)).toHaveLength(3);
    update(tree, 'ready');
    expect(tree.toJSON()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('carries straight on when the black screen gives way to the page while the clip is still coming', () => {
    const shell = mount();
    layOut(shell, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    expect(bigSparkles(shell)).toHaveLength(1);
    renderer.act(() => shell.unmount());

    advance(MEDIA_SPARKLE_HANDOFF_MS - 50);
    const page = mount();
    layOut(page, 390, 844);
    advance(1);
    expect(bigSparkles(page)).toHaveLength(1);
    renderer.act(() => page.unmount());
  });

  it('waits its own delay after a sparkle that went with its media, or long ago', () => {
    const first = mount();
    layOut(first, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS);
    update(first, 'ready');
    advance(MEDIA_SPARKLE_BURST_MS);
    renderer.act(() => first.unmount());
    const next = mount();
    layOut(next, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS - 1);
    expect(bigSparkles(next)).toHaveLength(0);
    advance(1);
    expect(bigSparkles(next)).toHaveLength(1);
    renderer.act(() => next.unmount());

    // `next` went mid-wait, but the window has passed by the time another starts.
    advance(MEDIA_SPARKLE_HANDOFF_MS);
    const late = mount();
    layOut(late, 390, 844);
    advance(MEDIA_SPARKLE_DELAY_MS - 1);
    expect(bigSparkles(late)).toHaveLength(0);
    renderer.act(() => late.unmount());
  });

  it('takes a layout callback with no event, as some suites fire one', () => {
    const tree = mount();
    expect(() => renderer.act(() => box(tree).props.onLayout())).not.toThrow();
    renderer.act(() => tree.unmount());
  });
});
