import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type Listener = (event: { data?: { closing?: boolean } }) => void;

const navigation = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
      return () => listeners.get(type)!.delete(listener);
    },
    emit(type: string, data?: { closing?: boolean }) {
      listeners.get(type)?.forEach((listener) => listener({ data }));
    },
  };
});

vi.mock('expo-router', () => ({ useNavigation: () => navigation }));

import { useScreenLeaving } from '../lib/use-screen-leaving';

function mountProbe() {
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useScreenLeaving());
    return null;
  }
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<Probe />);
  });
  const emit = (type: string, data?: { closing?: boolean }) => renderer.act(() => navigation.emit(type, data));
  const unmount = () => renderer.act(() => tree.unmount());
  return { leaving: () => seen[seen.length - 1], emit, unmount };
}

describe('useScreenLeaving', () => {
  it('turns on as a close starts, long before the screen is removed', () => {
    const probe = mountProbe();
    expect(probe.leaving()).toBe(false);

    probe.emit('transitionStart', { closing: true });
    expect(probe.leaving()).toBe(true);
    // The close finishing keeps it gone.
    probe.emit('transitionEnd', { closing: true });
    expect(probe.leaving()).toBe(true);
    probe.unmount();
  });

  it('turns off again when a back swipe is let go of before it commits', () => {
    const probe = mountProbe();
    probe.emit('transitionStart', { closing: true });
    probe.emit('gestureCancel');
    expect(probe.leaving()).toBe(false);

    probe.emit('transitionStart', { closing: true });
    probe.emit('transitionStart', { closing: false });
    expect(probe.leaving()).toBe(false);

    probe.emit('transitionStart', { closing: true });
    probe.emit('transitionEnd', { closing: false });
    expect(probe.leaving()).toBe(false);
    probe.unmount();
  });

  it('stays off while the screen is opening', () => {
    const probe = mountProbe();
    probe.emit('transitionStart', { closing: false });
    probe.emit('transitionEnd', { closing: false });
    expect(probe.leaving()).toBe(false);
    probe.unmount();
  });

  it('stops listening once unmounted', () => {
    const probe = mountProbe();
    probe.unmount();
    for (const set of navigation.listeners.values()) expect(set.size).toBe(0);
  });
});
