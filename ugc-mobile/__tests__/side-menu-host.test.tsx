// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readFileSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = Record<string, unknown>;

// The drawer itself has its own suites (home-side-menu*.test.tsx); here it is
// a host element whose props say what it was asked to draw.
vi.mock('@/components/home-side-menu', () => ({
  HomeSideMenu: (props: MockProps) => React.createElement('home-side-menu', props),
}));

const signOut = vi.fn(async () => undefined);
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    api: { getProfile: vi.fn() },
    credits: 1200,
    signOut,
    user: { id: 'user-1' },
  }),
}));

const queries = vi.hoisted(() => ({ enabled: [] as boolean[] }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ enabled }: { enabled: boolean }) => {
    queries.enabled.push(enabled);
    return { data: { sales: { earningsUsdCents: 1250 } } };
  },
}));

import { TabBarSideMenu } from '../components/workspace-side-menu';
import {
  createSideMenuStore,
  SideMenuHostContext,
  useWorkspaceSideMenuState,
  type SideMenuStore,
  type WorkspaceSideMenuState,
} from '../lib/side-menu-host';

const mobileRoot = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(mobileRoot, file), 'utf8');

describe('createSideMenuStore', () => {
  it('tells its readers when the menu opens and closes, once per change', () => {
    const store = createSideMenuStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.isOpen()).toBe(false);
    store.open();
    store.open();
    expect(store.isOpen()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.close();
    store.close();
    expect(store.isOpen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.open();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

/** A tab screen that offers the menu, as Home and Explore do. */
let screenRenders = 0;
function ScreenFixture({ onState }: { onState: (state: WorkspaceSideMenuState) => void }) {
  const state = useWorkspaceSideMenuState();
  screenRenders += 1;
  onState(state);
  return React.createElement('tab-screen', null);
}

function drawer(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'home-side-menu');
}

function renderTabs(store: SideMenuStore, { withScreen }: { withScreen: boolean }) {
  let screenState: WorkspaceSideMenuState | null = null;
  const element = (
    <SideMenuHostContext.Provider value={store}>
      {withScreen ? <ScreenFixture onState={(state) => { screenState = state; }} /> : null}
      <TabBarSideMenu />
    </SideMenuHostContext.Provider>
  );
  return { element, screen: () => screenState };
}

describe('the side menu drawn by the tab bar', () => {
  it('opens and closes without rendering the screen that offers it', () => {
    // Home is the app's heaviest render. Subscribed to the menu, it was
    // rendered again, at sync priority, by every open and by the close that
    // lands while ☰ → Settings is being built.
    const store = createSideMenuStore();
    const tabs = renderTabs(store, { withScreen: true });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(tabs.element);
    });
    const rendersBefore = screenRenders;

    renderer.act(() => tabs.screen()?.open());
    expect(drawer(tree)[0].props.visible).toBe(true);
    renderer.act(() => (drawer(tree)[0].props.onClose as () => void)());
    expect(drawer(tree)[0].props.visible).toBe(false);

    expect(screenRenders).toBe(rendersBefore);
  });

  it('outlives the tab screen it was opened from', () => {
    // Profile and Credits switch tabs, and react-native-screens takes the tab
    // that is left off the window at once on Android. Drawn inside Home's
    // screen, the menu's Modal went with it, and Home showed bare for two
    // frames before the new tab (Pixel 9a emulator, 2026-11-03). Drawn by the
    // tab bar, it stays up while the screen that opened it goes.
    const store = createSideMenuStore();
    const tabs = renderTabs(store, { withScreen: true });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(tabs.element);
    });

    expect(tabs.screen()?.hosted).toBe(true);
    expect(drawer(tree)).toHaveLength(1);
    expect(drawer(tree)[0].props.visible).toBe(false);

    renderer.act(() => tabs.screen()?.open());
    expect(drawer(tree)[0].props.visible).toBe(true);
    expect(tabs.screen()?.isOpen()).toBe(true);
    expect(tabs.screen()?.ownMenuVisible).toBe(false);

    // The tab switch: the screen is gone, the menu is not.
    renderer.act(() => tree.update(renderTabs(store, { withScreen: false }).element));
    expect(tree.root.findAll((node) => String(node.type) === 'tab-screen')).toHaveLength(0);
    expect(drawer(tree)).toHaveLength(1);
    expect(drawer(tree)[0].props.visible).toBe(true);

    // Its own close (the hand-off's, Close, the scrim, Back) reaches the store.
    renderer.act(() => (drawer(tree)[0].props.onClose as () => void)());
    expect(store.isOpen()).toBe(false);
    expect(drawer(tree)[0].props.visible).toBe(false);
  });

  it('gives the drawer the account, the balance and the tracked earnings, reading the profile only while it is up', () => {
    queries.enabled.length = 0;
    const store = createSideMenuStore();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(renderTabs(store, { withScreen: false }).element);
    });
    expect(queries.enabled.at(-1)).toBe(false);

    renderer.act(() => store.open());
    const props = drawer(tree)[0].props;
    expect(queries.enabled.at(-1)).toBe(true);
    expect(props.user).toEqual({ id: 'user-1' });
    expect(props.credits).toBe(1200);
    expect(props.totalSalesUsdCents).toBe(1250);
    expect(props.onSignOut).toBe(signOut);
  });

  it('draws nothing without the tabs layout, and a screen there keeps the menu itself', () => {
    let screenState: WorkspaceSideMenuState | null = null;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <>
          <ScreenFixture onState={(state) => { screenState = state; }} />
          <TabBarSideMenu />
        </>,
      );
    });

    expect(drawer(tree)).toHaveLength(0);
    expect(screenState!.hosted).toBe(false);
    renderer.act(() => screenState!.open());
    expect(screenState!.ownMenuVisible).toBe(true);
    expect(screenState!.isOpen()).toBe(true);
    renderer.act(() => screenState!.close());
    expect(screenState!.ownMenuVisible).toBe(false);
    expect(screenState!.isOpen()).toBe(false);
  });
});

describe('where the side menu is drawn', () => {
  it('is provided around the tab screens and the tab bar, and drawn by the bar', () => {
    const layout = read('app/(tabs)/_layout.tsx');
    const provided = layout.slice(
      layout.indexOf('<SideMenuHostContext.Provider value={sideMenu}>'),
      layout.indexOf('</SideMenuHostContext.Provider>'),
    );
    expect(provided).toContain('<Tabs');
    expect(provided).toContain('<MagicTabBar');

    // In the bar's root view, beside the Create menu: the view that stays on
    // the window across tab switches and is never flattened.
    const bar = read('components/magic-tab-bar.tsx');
    const root = bar.slice(bar.indexOf('collapsable={false}'), bar.indexOf('<AndroidNavigationDock'));
    expect(root).toContain('<MagicCreateMenu');
    expect(root).toContain('<TabBarSideMenu />');
  });

  it('is never drawn by Home or Explore while the tab bar draws it', () => {
    for (const file of ['components/home-dashboard.tsx', 'components/workspace-side-menu-gesture-layer.tsx']) {
      const source = read(file);
      expect(source, file).not.toContain('<HomeSideMenu');
      expect(source, file).toContain('useWorkspaceSideMenuState()');
      expect(source, file).toMatch(/sideMenu\.hosted \? null : \(\s*<WorkspaceSideMenu /);
    }
  });
});
