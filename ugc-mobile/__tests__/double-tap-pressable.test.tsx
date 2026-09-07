import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { appListeners } = vi.hoisted(() => ({ appListeners: new Map<string, Set<(state?: string) => void>>() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: (name: string, fn: (state?: string) => void) => {
    const group = appListeners.get(name) ?? new Set(); group.add(fn); appListeners.set(name, group);
    return { remove: () => group.delete(fn) };
  } },
  Pressable: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('pressable', props, children),
}));

import { DoubleTapPressable } from '../components/double-tap-pressable';

afterEach(() => {
  vi.useRealTimers();
  appListeners.clear();
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

for (const event of ['change', 'blur']) {
  it(`cancels a pending tap on ${event}, then accepts a fresh foreground tap`, () => {
    vi.useFakeTimers();
    const single = vi.fn(), double = vi.fn();
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<DoubleTapPressable onSinglePress={single} onDoublePress={double} />); });
    const press = () => tree!.root.find(node => String(node.type) === 'pressable').props.onPress();
    renderer.act(() => {
      press(); vi.advanceTimersByTime(100);
      appListeners.get(event)?.forEach(fn => fn('background'));
      appListeners.get('change')?.forEach(fn => fn('active'));
      vi.advanceTimersByTime(180);
    });
    expect(single).not.toHaveBeenCalled();
    renderer.act(() => { press(); vi.advanceTimersByTime(280); });
    expect(single).toHaveBeenCalledOnce();
    expect(double).not.toHaveBeenCalled();
    renderer.act(() => tree!.unmount());
    expect([...appListeners.values()].every(group => group.size === 0)).toBe(true);
  });
}
