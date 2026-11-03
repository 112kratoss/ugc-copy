// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The navigation container as the hand-off reads it: the focused route, and
 * the `state` event the real container emits once a navigation has been
 * committed. `land` is that event.
 */
const container = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const fake = {
    routeKey: 'home-key',
    listeners,
    ref: {
      isReady: () => true,
      getCurrentRoute: () => ({ key: fake.routeKey, name: fake.routeKey.replace(/-key$/, '') }),
      addListener: (_type: string, callback: () => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
    land(routeKey: string) {
      fake.routeKey = routeKey;
      for (const listener of [...listeners]) listener();
    },
  };
  return fake;
});

vi.mock('expo-router', () => ({ useNavigationContainerRef: () => container.ref }));

import { useMenuHandoff, type MenuHandoff } from '../lib/menu-handoff';

type Options = { visible: boolean; onClose: () => void };

function Harness({ options, onRender }: { options: Options; onRender: (handoff: MenuHandoff<string>) => void }) {
  onRender(useMenuHandoff<string>(options));
  return null;
}

function renderHandoff(options: Options) {
  const renders: MenuHandoff<string>[] = [];
  const element = (next: Options) => <Harness options={next} onRender={(handoff) => renders.push(handoff)} />;
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element(options));
  });
  return {
    latest: () => renders[renders.length - 1],
    update: (next: Options) => renderer.act(() => tree.update(element(next))),
    unmount: () => renderer.act(() => tree.unmount()),
  };
}

/** A push: expo-router builds the screen a render later, so the route has not moved yet. */
const pushSettings = () => undefined;

beforeEach(() => {
  container.routeKey = 'home-key';
  container.listeners.clear();
});

/**
 * Review of #679, B6: a menu taken off screen while its hand-off waits never
 * leaves, so its owner was never told to close. The reel keys its comments
 * sheet by post: one unmounted there kept the reel's video blocked, and the
 * sheet came back when the post did.
 */
describe('useMenuHandoff when the menu goes mid hand-off', () => {
  it('tells the owner, once, with its latest close', () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const menu = renderHandoff({ visible: true, onClose: firstClose });

    renderer.act(() => menu.latest().handOff('/settings', pushSettings));
    // The owner re-rendered while the screen was being built.
    menu.update({ visible: true, onClose: latestClose });
    menu.unmount();

    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);
  });

  it('tells the owner nothing more once the menu has left', () => {
    const onClose = vi.fn();
    const menu = renderHandoff({ visible: true, onClose });

    renderer.act(() => menu.latest().handOff('/settings', pushSettings));
    renderer.act(() => container.land('settings-key'));
    expect(onClose).toHaveBeenCalledTimes(1);

    // The owner's close is what takes some menus off screen (Home's sheet).
    menu.unmount();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tells the owner nothing more after a navigation that went nowhere', () => {
    const onClose = vi.fn();
    const menu = renderHandoff({ visible: true, onClose });

    renderer.act(() => menu.latest().handOff('creator', () => false));
    expect(onClose).toHaveBeenCalledTimes(1);

    menu.unmount();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tells the owner nothing when no screen was handed off', () => {
    const onClose = vi.fn();
    renderHandoff({ visible: true, onClose }).unmount();

    // Sign out takes the menu's one choice and closes the menu itself.
    const signingOut = renderHandoff({ visible: true, onClose });
    renderer.act(() => {
      expect(signingOut.latest().claim()).toBe(true);
    });
    signingOut.unmount();

    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * Review of #679: `handOff` and `claim` were new functions on every render
 * wherever the compiler did not memoize this hook. The comments sheet, which
 * the compiler skips, lists `handOff` among its callbacks' dependencies, so
 * each render rebuilt the author and sign-in handlers of every comment row.
 */
describe('useMenuHandoff callbacks', () => {
  it('keeps handOff and claim through re-renders and a whole hand-off', () => {
    const menu = renderHandoff({ visible: true, onClose: vi.fn() });
    const { handOff, claim } = menu.latest();

    menu.update({ visible: true, onClose: vi.fn() });
    expect(menu.latest().handOff).toBe(handOff);
    expect(menu.latest().claim).toBe(claim);

    renderer.act(() => menu.latest().handOff('/settings', pushSettings));
    renderer.act(() => container.land('settings-key'));
    menu.update({ visible: false, onClose: vi.fn() });

    expect(menu.latest().leaving).toBe(true);
    expect(menu.latest().handOff).toBe(handOff);
    expect(menu.latest().claim).toBe(claim);
  });
});
