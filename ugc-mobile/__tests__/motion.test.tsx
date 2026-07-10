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
        return Promise.resolve(false);
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
    },
  };
});

import { useAnimatedState, usePressMotion, useReducedMotion } from '../lib/motion';

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

describe('motion hooks', () => {
  beforeEach(() => {
    nativeState.addListenerCalls = 0;
    nativeState.preferenceReads = 0;
    nativeState.removeListenerCalls = 0;
    nativeState.valueInitials = [];
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
