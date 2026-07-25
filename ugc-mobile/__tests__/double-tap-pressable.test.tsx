import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Pressable: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('pressable', props, children),
}));

import { DoubleTapPressable } from '../components/double-tap-pressable';

afterEach(() => {
  vi.useRealTimers();
});

describe('DoubleTapPressable', () => {
  it('runs the double action once and cancels the pending single action', () => {
    vi.useFakeTimers();
    const onDoublePress = vi.fn();
    const onSinglePress = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <DoubleTapPressable onDoublePress={onDoublePress} onSinglePress={onSinglePress} />
      );
    });

    const pressable = tree!.root.find((node) => String(node.type) === 'pressable');
    renderer.act(() => {
      pressable.props.onPress();
      vi.advanceTimersByTime(120);
      pressable.props.onPress();
      vi.runAllTimers();
    });

    expect(onDoublePress).toHaveBeenCalledTimes(1);
    expect(onSinglePress).not.toHaveBeenCalled();
  });

  it('runs the single action after the double-tap window expires', () => {
    vi.useFakeTimers();
    const onDoublePress = vi.fn();
    const onSinglePress = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <DoubleTapPressable onDoublePress={onDoublePress} onSinglePress={onSinglePress} />
      );
    });

    renderer.act(() => {
      tree!.root.find((node) => String(node.type) === 'pressable').props.onPress();
      vi.advanceTimersByTime(280);
    });

    expect(onSinglePress).toHaveBeenCalledTimes(1);
    expect(onDoublePress).not.toHaveBeenCalled();
  });

  it('replays the double action for each completed pair of rapid taps', () => {
    vi.useFakeTimers();
    const onDoublePress = vi.fn();
    const onSinglePress = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <DoubleTapPressable onDoublePress={onDoublePress} onSinglePress={onSinglePress} />
      );
    });

    const pressable = tree!.root.find((node) => String(node.type) === 'pressable');
    renderer.act(() => {
      pressable.props.onPress();
      vi.advanceTimersByTime(90);
      pressable.props.onPress();
      vi.advanceTimersByTime(90);
      pressable.props.onPress();
      vi.advanceTimersByTime(90);
      pressable.props.onPress();
      vi.runAllTimers();
    });

    expect(onDoublePress).toHaveBeenCalledTimes(2);
    expect(onSinglePress).not.toHaveBeenCalled();
  });

  it('forwards the second tap location to the double action', () => {
    vi.useFakeTimers();
    const onDoublePress = vi.fn();
    const firstTap = { nativeEvent: { locationX: 24, locationY: 180 } };
    const secondTap = { nativeEvent: { locationX: 76, locationY: 260 } };
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <DoubleTapPressable onDoublePress={onDoublePress} />
      );
    });

    const pressable = tree!.root.find((node) => String(node.type) === 'pressable');
    renderer.act(() => {
      pressable.props.onPress(firstTap);
      vi.advanceTimersByTime(90);
      pressable.props.onPress(secondTap);
    });

    expect(onDoublePress).toHaveBeenCalledWith(secondTap);
  });
});
