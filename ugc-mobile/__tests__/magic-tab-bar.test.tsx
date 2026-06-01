import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const routerState = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: routerState,
}));

vi.mock('react-native', () => ({
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  Text: ({ children, ...props }: MockProps) =>
    React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) =>
    React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: MockProps) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) =>
    React.createElement('linear-gradient', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  Bell: (props: Record<string, unknown>) => React.createElement('bell-icon', props),
  FilePlus2: (props: Record<string, unknown>) => React.createElement('file-plus-icon', props),
  Home: (props: Record<string, unknown>) => React.createElement('home-icon', props),
  Plus: (props: Record<string, unknown>) => React.createElement('plus-icon', props),
  Sparkles: (props: Record<string, unknown>) => React.createElement('sparkles-icon', props),
  Users: (props: Record<string, unknown>) => React.createElement('users-icon', props),
  User: (props: Record<string, unknown>) => React.createElement('user-icon', props),
  X: (props: Record<string, unknown>) => React.createElement('x-icon', props),
}));

vi.mock('@/components/magic-create-menu', async () =>
  vi.importActual('../components/magic-create-menu')
);

vi.mock('@/lib/create-menu-view-model', async () =>
  vi.importActual('../lib/create-menu-view-model')
);

vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (value: number) => value,
}));

vi.mock('@/lib/tab-bar-layout', async () =>
  vi.importActual('../lib/tab-bar-layout')
);

vi.mock('@/lib/theme', () => ({
  appTheme: {
    colors: {
      muted: '#a1a1aa',
    },
  },
}));

import { MagicTabBar } from '../components/magic-tab-bar';

const routes = [
  { key: 'home-key', name: 'index' },
  { key: 'showcase-key', name: 'showcase' },
  { key: 'creator-key', name: 'creator' },
  { key: 'studio-key', name: 'studio' },
  { key: 'profile-key', name: 'profile' },
];

function renderTabBar() {
  const navigation = {
    emit: vi.fn(() => ({ defaultPrevented: false })),
    navigate: vi.fn(),
    jumpTo: vi.fn(),
  };
  const state = {
    index: 0,
    key: 'tabs-key',
    routeNames: routes.map((route) => route.name),
    routes,
    stale: false,
    type: 'tab',
    history: [],
  };

  let tree: ReturnType<typeof renderer.create> | undefined;
  renderer.act(() => {
    tree = renderer.create(
      <MagicTabBar
        state={state as never}
        descriptors={{} as never}
        navigation={navigation as never}
        insets={{ top: 0, right: 0, bottom: 0, left: 0 }}
      />
    );
  });

  return { tree: tree!, navigation };
}

describe('MagicTabBar create menu', () => {
  beforeEach(() => {
    routerState.push.mockClear();
  });

  it('opens and closes the action menu from the center button', () => {
    const { tree } = renderTabBar();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.onPress();
    });

    expect(tree.root.findByProps({ accessibilityLabel: 'Create' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Post' })).toBeTruthy();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Close create menu' }).props.onPress();
    });

    expect(() => tree.root.findByProps({ accessibilityLabel: 'Create' })).toThrow();
  });

  it('keeps Create routed to the existing creator tab', () => {
    const { tree, navigation } = renderTabBar();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.onPress();
    });
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Create' }).props.onPress();
    });

    expect(navigation.jumpTo).toHaveBeenCalledWith('creator');
    expect(routerState.push).not.toHaveBeenCalled();
  });

  it('routes Post to the publish flow', () => {
    const { tree, navigation } = renderTabBar();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.onPress();
    });
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Post' }).props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledWith('/post/new');
    expect(navigation.jumpTo).not.toHaveBeenCalled();
  });
});
