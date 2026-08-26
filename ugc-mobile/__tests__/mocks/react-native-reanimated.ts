/**
 * Test double for `react-native-reanimated`. The real package re-exports
 * `react-native/index.js`, whose Flow syntax vitest cannot parse, so importing
 * it fails before a single assertion runs. Aliased globally in vitest.config.ts.
 *
 * Animated components render as string host elements, matching the
 * `React.createElement('view', …)` convention the react-native mocks in this
 * suite already use. Animated styles are resolved once at render time, so a
 * rendered tree shows the style the worklet would produce for the current
 * shared values — enough to assert layout intent without a UI thread.
 *
 * Suites needing to observe animation calls still `vi.mock` this module.
 */
import React from 'react';

type AnyProps = { children?: React.ReactNode } & Record<string, unknown>;

function hostComponent(tag: string) {
  const Component = ({ children, ...props }: AnyProps) =>
    React.createElement(tag, props, children);
  Component.displayName = tag;
  return Component;
}

export type SharedValue<T> = { value: T };

export function useSharedValue<T>(initial: T): SharedValue<T> {
  return { value: initial };
}

export function useDerivedValue<T>(factory: () => T): SharedValue<T> {
  return { value: factory() };
}

export function useAnimatedStyle<T>(factory: () => T): T {
  return factory();
}

/** Closed keyboard: the state every test starts from unless it mocks this module. */
export function useAnimatedKeyboard() {
  return {
    height: { value: 0 },
    state: { value: KeyboardState.CLOSED },
  };
}

export const KeyboardState = {
  UNKNOWN: 0,
  OPENING: 1,
  OPEN: 2,
  CLOSING: 3,
  CLOSED: 4,
} as const;

export function withTiming<T>(toValue: T) {
  return toValue;
}

export function withSpring<T>(toValue: T) {
  return toValue;
}

export function withDelay<T>(_delay: number, animation: T) {
  return animation;
}

export function runOnJS<T extends (...args: never[]) => unknown>(fn: T) {
  return fn;
}

export function runOnUI<T extends (...args: never[]) => unknown>(fn: T) {
  return fn;
}

export const Extrapolation = {
  CLAMP: 'clamp',
  EXTEND: 'extend',
  IDENTITY: 'identity',
} as const;

export function interpolate(
  value: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  extrapolation: string = Extrapolation.EXTEND,
) {
  if (inputRange.length < 2 || outputRange.length < 2) return outputRange[0] ?? 0;

  let upper = 1;
  while (upper < inputRange.length - 1 && value > inputRange[upper]) upper += 1;
  const lower = upper - 1;

  const inputSpan = inputRange[upper] - inputRange[lower];
  const progress = inputSpan === 0 ? 0 : (value - inputRange[lower]) / inputSpan;
  const clamped = extrapolation === Extrapolation.CLAMP
    ? Math.min(1, Math.max(0, progress))
    : progress;

  return outputRange[lower] + clamped * (outputRange[upper] - outputRange[lower]);
}

const Animated = {
  View: hostComponent('animated-view'),
  Text: hostComponent('animated-text'),
  ScrollView: hostComponent('animated-scroll-view'),
  Image: hostComponent('animated-image'),
  createAnimatedComponent: <P,>(Component: React.ComponentType<P>) => Component,
};

export default Animated;
