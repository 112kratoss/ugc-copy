import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useHardwareBack } from '@/lib/use-hardware-back';

const { backHandler } = vi.hoisted(() => {
  const remove = vi.fn();
  const listeners: Array<() => boolean> = [];
  return {
    backHandler: {
      listeners,
      remove,
      addEventListener: vi.fn((_event: string, listener: () => boolean) => {
        listeners.push(listener);
        return { remove };
      }),
    },
  };
});

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: backHandler.addEventListener,
  },
}));

function Host({ enabled, onBack }: { enabled: boolean; onBack: () => void }) {
  useHardwareBack(enabled, onBack);
  return null;
}

describe('useHardwareBack', () => {
  beforeEach(() => {
    backHandler.listeners.length = 0;
    backHandler.addEventListener.mockClear();
    backHandler.remove.mockClear();
  });

  it('does nothing while disabled', () => {
    act(() => {
      renderer.create(React.createElement(Host, { enabled: false, onBack: vi.fn() }));
    });

    expect(backHandler.addEventListener).not.toHaveBeenCalled();
  });

  it('claims the key while enabled and runs the latest handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(React.createElement(Host, { enabled: true, onBack: first }));
    });
    act(() => {
      tree!.update(React.createElement(Host, { enabled: true, onBack: second }));
    });

    expect(backHandler.addEventListener).toHaveBeenCalledTimes(1);
    expect(backHandler.addEventListener).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    expect(backHandler.listeners[0]()).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('lets go of the key when disabled again or unmounted', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(React.createElement(Host, { enabled: true, onBack: vi.fn() }));
    });
    act(() => {
      tree!.update(React.createElement(Host, { enabled: false, onBack: vi.fn() }));
    });
    expect(backHandler.remove).toHaveBeenCalledTimes(1);

    act(() => {
      tree!.update(React.createElement(Host, { enabled: true, onBack: vi.fn() }));
    });
    act(() => {
      tree!.unmount();
    });
    expect(backHandler.remove).toHaveBeenCalledTimes(2);
  });
});
