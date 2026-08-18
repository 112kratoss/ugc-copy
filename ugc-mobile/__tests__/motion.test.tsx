// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({
  addListenerCalls: 0,
  preferenceReads: 0,
  removeListenerCalls: 0,
  valueInitials: [] as number[],
  springTargets: [] as number[],
  reduceMotion: false,
}));

vi.mock('react-native', () => {
  class MockAnimatedValue {
    constructor(initialValue: number) {
      nativeState.valueInitials.push(initialValue);
    }

    setValue() {}

    stopAnimation() {}
  }

  return {
    AccessibilityInfo: {
      isReduceMotionEnabled: () => {
        nativeState.preferenceReads += 1;
        return Promise.resolve(nativeState.reduceMotion);
      },
      addEventListener: () => {
        nativeState.addListenerCalls += 1;
        return {
          remove: () => {
            nativeState.removeListenerCalls += 1;
          },
        };
      },
    },
    Animated: {
      Value: MockAnimatedValue,
      timing: () => ({ start: vi.fn() }),
      spring: (_value: unknown, config: { toValue: number }) => {
        nativeState.springTargets.push(config.toValue);
        return { start: vi.fn() };
      },
    },
  };
});

import { useAnimatedState, usePressMotion, useReducedMotion, useSpringState } from '../lib/motion';

function ReducedMotionProbe({ testID }: { testID: string }) {
  const reducedMotion = useReducedMotion();
  return React.createElement('probe', { testID, reducedMotion });
}

function AnimatedValueProbe({ active }: { active: boolean }) {
  const pressMotion = usePressMotion();
  const progress = useAnimatedState(active);
  return React.createElement('probe', {
    active,
    onFocus: pressMotion.onFocus,
    progress,
  });
}

function SpringProbe({ active }: { active: boolean }) {
  const progress = useSpringState(active);
  return React.createElement('probe', { active, progress });
}

describe('motion hooks', () => {
  beforeEach(() => {
    nativeState.addListenerCalls = 0;
    nativeState.preferenceReads = 0;
    nativeState.removeListenerCalls = 0;
    nativeState.valueInitials = [];
    nativeState.springTargets = [];
    nativeState.reduceMotion = false;
  });

  it('settles selection with a spring rather than a fixed curve', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<SpringProbe active={false} />);
    });

    renderer.act(() => {
      tree!.update(<SpringProbe active />);
    });

    // A timing curve here would mean the selection reads as merely animated;
    // the spring settle is the whole point of the expressive treatment.
    expect(nativeState.springTargets).toContain(1);

    renderer.act(() => {
      tree!.unmount();
    });
  });

  it('shares one native reduced-motion subscription across consumers', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <>
          <ReducedMotionProbe testID="first" />
          <ReducedMotionProbe testID="second" />
        </>
      );
    });

    expect(nativeState.preferenceReads).toBe(1);
    expect(nativeState.addListenerCalls).toBe(1);

    renderer.act(() => {
      tree!.unmount();
    });

    expect(nativeState.removeListenerCalls).toBe(1);
  });

  it('creates animated values once instead of reallocating them on rerender', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AnimatedValueProbe active={false} />);
    });

    expect(nativeState.valueInitials).toEqual([1, 0]);

    const probe = tree!.root.find((node) => String(node.type) === 'probe');
    renderer.act(() => {
      probe.props.onFocus();
      tree!.update(<AnimatedValueProbe active />);
    });

    expect(nativeState.valueInitials).toEqual([1, 0]);

    renderer.act(() => {
      tree!.unmount();
    });
  });
});
