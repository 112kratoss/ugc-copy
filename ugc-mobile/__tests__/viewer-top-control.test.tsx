(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The reel's Back and sound controls (components/viewer-top-control.tsx), and
 * whether they show (lib/viewer-top-controls.ts). Under UIKit's zoom into the
 * reel they wait for the push to crossfade and go as a close begins
 * (`AppleZoomTopControlsCue`), and only they draw that answer.
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const glass = vi.hoisted(() => ({ available: true }));

vi.mock('expo-glass-effect', () => ({
  GlassView: ({ children, ...props }: MockProps) => React.createElement('glass-view', props, children),
  isGlassEffectAPIAvailable: () => glass.available,
  isLiquidGlassAvailable: () => glass.available,
}));

// An Animated value that lands on wherever a timing sends it, so a test reads
// what the control is fading to.
const animated = vi.hoisted(() => {
  class Value {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
      this.value = value;
    }
    stopAnimation() {}
    interpolate() {
      return this;
    }
  }
  const timing = vi.fn((value: Value, config: { toValue: number; duration?: number }) => ({
    start: () => value.setValue(config.toValue),
    stop: () => {},
  }));
  return { Value, timing };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    addEventListener: () => ({ remove: () => {} }),
    isReduceMotionEnabled: () => new Promise<boolean>(() => {}),
    isReduceTransparencyEnabled: () => Promise.resolve(false),
  },
  Animated: {
    View: ({ children, ...props }: MockProps) => React.createElement('animated-view', props, children),
    Value: animated.Value,
    spring: () => ({ start: () => {}, stop: () => {} }),
    timing: animated.timing,
  },
  Easing: { bezier: () => (t: number) => t, cubic: (t: number) => t, in: (f: unknown) => f, out: (f: unknown) => f, quad: (t: number) => t },
  Platform: { OS: 'ios' },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ scheme: 'dark' }) }));

import { ViewerTopControl } from '../components/viewer-top-control';
import { createViewerTopControls, ViewerTopControlsContext, type ViewerTopControls } from '../lib/viewer-top-controls';

const mounted: renderer.ReactTestRenderer[] = [];

afterEach(() => {
  mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
  glass.available = true;
  animated.timing.mockClear();
});

function BackControl() {
  return (
    <ViewerTopControl label="Go back" onPress={() => {}} topInset={59} side="left">
      {React.createElement('back-glyph')}
    </ViewerTopControl>
  );
}

/** The reel, as far as its controls go: it counts its own renders. */
function Reel({ renders }: { renders: { count: number } }) {
  renders.count += 1;
  return <BackControl />;
}

function mount(controls: ViewerTopControls | null, renders = { count: 0 }) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(controls
      ? <ViewerTopControlsContext.Provider value={controls}><Reel renders={renders} /></ViewerTopControlsContext.Provider>
      : <Reel renders={renders} />);
  });
  mounted.push(tree);
  return { tree, renders };
}

const host = (tree: renderer.ReactTestRenderer, type: string) => tree.root.find((node) => (node.type as unknown) === type);

/** The glass's material, which comes and goes through its own style. */
const material = (tree: renderer.ReactTestRenderer) => (host(tree, 'glass-view').props.glassEffectStyle as { style: string }).style;

describe('whether the reel\'s top controls show', () => {
  it('is told to its listeners when it changes, and only then', () => {
    const controls = createViewerTopControls(false);
    const listener = vi.fn();
    const unsubscribe = controls.subscribe(listener);
    controls.setShown(false);
    expect(listener).not.toHaveBeenCalled();
    controls.setShown(true);
    expect(controls.isShown()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    controls.setShown(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is drawn by the controls alone: the reel holding them is not drawn again as they come in', () => {
    const controls = createViewerTopControls(false);
    const { tree, renders } = mount(controls);
    expect(material(tree)).toBe('none');
    renderer.act(() => controls.setShown(true));
    expect(material(tree)).toBe('regular');
    renderer.act(() => controls.setShown(false));
    expect(material(tree)).toBe('none');
    expect(renders.count).toBe(1);
  });

  it('starts shown on a reel that did not grow out of a tile, and outside any reel', () => {
    expect(material(mount(createViewerTopControls(true)).tree)).toBe('regular');
    expect(material(mount(null).tree)).toBe('regular');
  });
});

/** The control's own frame: the glass where there is glass, its plain backing otherwise. */
const frameOf = (tree: renderer.ReactTestRenderer) => host(tree, glass.available ? 'glass-view' : 'animated-view');

// Hidden for up to 700 ms of every zoom into the reel, and from the start of
// every close: a tap in that corner acted on a control nobody could see, and
// VoiceOver could land on an invisible "Go back".
describe('a hidden control', () => {
  it.each([
    ['glass', true],
    ['a plain backing', false],
  ])('on %s takes no touches and is not read out until it shows', (_surface, available) => {
    glass.available = available;
    const controls = createViewerTopControls(false);
    const { tree } = mount(controls);
    expect(frameOf(tree).props).toMatchObject({
      pointerEvents: 'none',
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    renderer.act(() => controls.setShown(true));
    expect(frameOf(tree).props).toMatchObject({
      pointerEvents: 'auto',
      accessibilityElementsHidden: false,
      importantForAccessibility: 'auto',
    });
    expect(host(tree, 'pressable').props).toMatchObject({ accessibilityRole: 'button', accessibilityLabel: 'Go back' });
    renderer.act(() => controls.setShown(false));
    expect(frameOf(tree).props.pointerEvents).toBe('none');
  });
});
