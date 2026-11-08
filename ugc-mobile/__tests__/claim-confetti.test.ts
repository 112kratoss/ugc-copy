import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const harness = vi.hoisted(() => ({
  reducedMotion: true,
  timings: [] as Array<Record<string, unknown>>,
  started: 0,
}));

vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
    setValue() {}
    interpolate() { return 0; }
  }
  return {
    Animated: {
      Value,
      View: (props: MockProps) => React.createElement('animated-view', props, props.children),
      timing: (_value: unknown, config: Record<string, unknown>) => { harness.timings.push(config); return {}; },
      parallel: () => ({ start() { harness.started += 1; }, stop() {} }),
    },
    Easing: { linear: () => 0 },
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  };
});
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => harness.reducedMotion }));
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: new Proxy({}, { get: (_target, name) => `token-${String(name)}` }) }) }));

import { CLAIM_CONFETTI_MS, ClaimConfetti, claimConfettiPieces } from '../components/claim-confetti';
import * as sharedFlight from '../lib/claim-confetti-flight/claim-confetti-flight';

describe('the claim confetti (owner 11-09: "premium feel ... satisfaction of gaining something")', () => {
  const pieces = claimConfettiPieces();

  it('is a few dozen pieces, the same every time, in five tones and three shapes', () => {
    expect(pieces).toHaveLength(48);
    expect(claimConfettiPieces()).toEqual(pieces);
    expect(new Set(pieces.map((piece) => piece.tone)).size).toBe(5);
    expect(new Set(pieces.map((piece) => piece.shape))).toEqual(new Set(['strip', 'chip', 'dot']));
    for (const piece of pieces) {
      expect(piece.width).toBeLessThanOrEqual(10);
      expect(piece.height).toBeLessThanOrEqual(18);
    }
  });

  it('is one burst: every piece is away within a tenth of a second', () => {
    for (const piece of pieces) expect(piece.delay).toBeLessThan(100);
    expect(new Set(pieces.map((piece) => piece.delay)).size).toBeGreaterThan(10);
  });

  it('is a real throw: each piece rises well clear of the figure, then falls back past it', () => {
    for (const piece of pieces) {
      const ys = piece.path.map((point) => point.y);
      const xs = piece.path.map((point) => point.x);
      expect(piece.path[0]).toEqual({ x: 0, y: 0 });
      expect(Math.min(...ys)).toBeLessThan(-40);
      expect(ys[ys.length - 1]).toBeGreaterThan(200);
      expect(Math.max(...xs.map(Math.abs))).toBeLessThan(460);
      // Rises first, then falls: one turn, no wobble.
      const apex = ys.indexOf(Math.min(...ys));
      for (let i = 1; i <= apex; i += 1) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);
      for (let i = apex + 1; i < ys.length; i += 1) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
    }
    // Both sides of the figure, so it reads as a burst and not a jet.
    expect(pieces.some((piece) => piece.path[piece.path.length - 1].x < -80)).toBe(true);
    expect(pieces.some((piece) => piece.path[piece.path.length - 1].x > 80)).toBe(true);
  });

  it('tumbles: each piece spins its own way', () => {
    expect(pieces.some((piece) => piece.spin < -360)).toBe(true);
    expect(pieces.some((piece) => piece.spin > 360)).toBe(true);
    expect(new Set(pieces.map((piece) => piece.flutterPhase)).size).toBe(pieces.length);
  });

  it('is the flight shared with the web, so both clients throw the same burst', () => {
    expect(claimConfettiPieces).toBe(sharedFlight.claimConfettiPieces);
    expect(CLAIM_CONFETTI_MS).toBe(sharedFlight.CLAIM_CONFETTI_MS);
    expect(sharedFlight.CLAIM_CONFETTI_TONES).toEqual(['primaryFill', 'navigationCreateTop', 'navigationCreateBottom', 'selectedStrong', 'surfaceInset']);
  });

  it('is over in under two seconds, so the card can leave beneath it', () => {
    expect(CLAIM_CONFETTI_MS).toBeLessThan(2000);
    expect(CLAIM_CONFETTI_MS).toBeGreaterThan(1400);
  });
});

describe('drawing the burst', () => {
  const origin = { x: 160, y: 340 };
  const trees: renderer.ReactTestRenderer[] = [];
  const render = (props: { ready: boolean; play: boolean; origin: { x: number; y: number } | null }) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(React.createElement(ClaimConfetti, props)); });
    trees.push(tree);
    return tree;
  };
  const views = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'animated-view');

  beforeEach(() => {
    harness.reducedMotion = false;
    harness.timings.length = 0;
    harness.started = 0;
    act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  });

  it('mounts every piece at the origin once ready, invisible and still, and throws them on play', () => {
    const tree = render({ ready: true, play: false, origin });
    expect(views(tree)).toHaveLength(48);
    expect(harness.started).toBe(0);
    act(() => { tree.update(React.createElement(ClaimConfetti, { ready: true, play: true, origin })); });
    expect(harness.started).toBe(1);
    expect(harness.timings).toHaveLength(48);
  });

  it('paints each piece in its tone from the theme', () => {
    const tree = render({ ready: true, play: false, origin });
    const colours = views(tree).map((view) => (view.props.style as { backgroundColor: string }).backgroundColor);
    expect(colours.slice(0, 5)).toEqual(sharedFlight.CLAIM_CONFETTI_TONES.map((name) => `token-${name}`));
  });

  it('runs every piece on the native driver, with its own flight', () => {
    render({ ready: true, play: true, origin });
    for (const config of harness.timings) {
      expect(config.useNativeDriver).toBe(true);
      expect(config.toValue).toBe(1);
    }
    expect(new Set(harness.timings.map((config) => config.duration)).size).toBeGreaterThan(10);
  });

  it('draws nothing without an origin, before it is ready, or under Reduce Motion', () => {
    expect(render({ ready: true, play: true, origin: null }).toJSON()).toBeNull();
    expect(render({ ready: false, play: false, origin }).toJSON()).toBeNull();
    harness.reducedMotion = true;
    expect(render({ ready: true, play: true, origin }).toJSON()).toBeNull();
    expect(harness.started).toBe(0);
  });
});
