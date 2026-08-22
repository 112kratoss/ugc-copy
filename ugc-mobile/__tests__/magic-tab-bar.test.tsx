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

const glassState = vi.hoisted(() => ({
  available: false,
  reduceTransparency: false,
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
  AccessibilityInfo: {
    isReduceTransparencyEnabled: () => Promise.resolve(glassState.reduceTransparency),
    addEventListener: () => ({ remove: () => {} }),
  },
}));

vi.mock('expo-blur', () => ({
  BlurView: ({ children, ...props }: MockProps) =>
    React.createElement('blur-view', props, children),
}));

vi.mock('expo-glass-effect', () => ({
  GlassView: ({ children, ...props }: MockProps) =>
    React.createElement('glass-view', props, children),
  isLiquidGlassAvailable: () => glassState.available,
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

function renderTabBar(activeIndex = 0, { hidden = false }: { hidden?: boolean } = {}) {
  const navigation = {
    emit: vi.fn(() => ({ defaultPrevented: false })),
    navigate: vi.fn(),
    jumpTo: vi.fn(),
  };
  const state = {
    index: activeIndex,
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
        hidden={hidden}
      />
    );
  });

  return { tree: tree!, navigation };
}

async function renderTabBarAsync(activeIndex = 0, options: { hidden?: boolean } = {}) {
  let result: ReturnType<typeof renderTabBar> | undefined;
  await renderer.act(async () => {
    result = renderTabBar(activeIndex, options);
  });
  return result!;
}

describe('MagicTabBar', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    glassState.available = false;
    glassState.reduceTransparency = false;
  });

  it('hides by going invisible and inert, never by unmounting the blur surface', async () => {
    const { tree } = await renderTabBarAsync(0, { hidden: true });

    // The blur surface must survive hiding: remounting it mid tab-fade is the
    // Android RenderNode-cycle crash. Invisibility comes from opacity, and
    // inertness from pointerEvents plus the accessibility-hidden pair.
    expect(tree.root.findAll((node) => String(node.type) === 'blur-view')).toHaveLength(1);

    const root = tree.root.findAll((node) => String(node.type) === 'view')[0];
    expect((root.props.style as Record<string, unknown>).opacity).toBe(0);
    expect(root.props.pointerEvents).toBe('none');
    expect(root.props.accessibilityElementsHidden).toBe(true);
    expect(root.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('stays visible and interactive when not hidden', async () => {
    const { tree } = await renderTabBarAsync();

    const root = tree.root.findAll((node) => String(node.type) === 'view')[0];
    expect((root.props.style as Record<string, unknown>).opacity).toBe(1);
    expect(root.props.pointerEvents).toBe('auto');
    expect(root.props.accessibilityElementsHidden).toBe(false);
    expect(root.props.importantForAccessibility).toBe('auto');
  });

  it('swaps the blur surface for Liquid Glass when the OS supports it', async () => {
    glassState.available = true;

    const { tree } = await renderTabBarAsync();

    expect(tree.root.findAll((node) => String(node.type) === 'glass-view')).toHaveLength(1);
    expect(tree.root.findAll((node) => String(node.type) === 'blur-view')).toHaveLength(0);
  });

  it('leaves the glass surface unpainted so the material is actually visible', async () => {
    glassState.available = true;

    const { tree } = await renderTabBarAsync();

    const glass = tree.root.find((node) => String(node.type) === 'glass-view');
    const style = glass.props.style as Record<string, unknown>;

    // The opaque panel fill is what defeated the old BlurView; if it ever comes
    // back on this branch the material renders as a flat slab. Tint is the other
    // route to the same mistake, so bound its alpha rather than pinning the
    // exact value — the design can move, the material still has to show through.
    expect(style.backgroundColor).toBeUndefined();
    expect(glass.props.colorScheme).toBe('dark');

    const tintAlpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(glass.props.tintColor as string)?.[1]);
    expect(tintAlpha).toBeLessThan(0.5);
  });

  it('asks Android for a real blur and gives it a target to sample', async () => {
    const { tree } = await renderTabBarAsync();

    const blur = tree.root.find((node) => String(node.type) === 'blur-view');

    // Without a method Android renders a plain semi-transparent view, and the
    // SDK31+ variant skips RenderScript on hardware that would choke on it.
    expect(blur.props.blurMethod).toBe('dimezisBlurViewSdk31Plus');

    // Bound rather than pinned: the exact tint is a design call that moved once
    // already. What must not come back is the opaque fill that made this bar a
    // flat slab, so the check sits well below that and leaves the design room.
    const style = blur.props.style as Record<string, unknown>;
    const tintAlpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(style.backgroundColor as string)?.[1]);
    expect(tintAlpha).toBeLessThan(0.8);
  });

  it('brightens the inactive labels on translucent surfaces only', async () => {
    glassState.reduceTransparency = true;
    const solid = await renderTabBarAsync();
    const solidIcon = solid.tree.root
      .findByProps({ accessibilityLabel: 'Showcase' })
      .findByType('users-icon' as never);

    glassState.reduceTransparency = false;
    glassState.available = true;
    const glass = await renderTabBarAsync();
    const glassIcon = glass.tree.root
      .findByProps({ accessibilityLabel: 'Showcase' })
      .findByType('users-icon' as never);

    // Muted grey is safe against a known opaque bar. Once the surface is
    // translucent the backdrop is whatever post scrolled past, so the label has
    // to carry itself.
    expect(solidIcon.props.color).toBe('#a1a1aa');
    expect(glassIcon.props.color).toBe('rgba(255,255,255,0.90)');
  });

  it('drops to a genuinely opaque bar when Reduce Transparency is on', async () => {
    glassState.available = true;
    glassState.reduceTransparency = true;

    const { tree } = await renderTabBarAsync();

    // Neither effect surface should render: this branch exists for users who
    // asked for less see-through, so it must not quietly stay translucent.
    expect(tree.root.findAll((node) => String(node.type) === 'glass-view')).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'blur-view')).toHaveLength(0);

    const opaque = tree.root.findAll((node) => {
      const style = node.props.style as Record<string, unknown> | undefined;
      return node.type === 'view' && style?.backgroundColor === 'rgba(17,18,21,0.96)';
    });
    expect(opaque).toHaveLength(1);
  });

  it('keeps the bottom safe-area continuation transparent under the restored nav', () => {
    const { tree } = renderTabBar();

    expect(tree.root.findAll((node) => String(node.type) === 'blur-view')).toHaveLength(1);

    const opaqueBottomFillers = tree.root.findAll((node) => {
      const style = node.props.style as Record<string, unknown> | undefined;
      return (
        node.type === 'view' &&
        style?.position === 'absolute' &&
        style?.left === 0 &&
        style?.right === 0 &&
        style?.bottom === 0 &&
        style?.height === 24 &&
        style?.backgroundColor === '#03040d'
      );
    });

    expect(opaqueBottomFillers).toHaveLength(0);
  });

  it('emits tabPress before navigating when the active tab is pressed again', () => {
    const { tree, navigation } = renderTabBar();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Home' }).props.onPress();
    });

    expect(navigation.emit).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'home-key',
      canPreventDefault: true,
    });
    expect(navigation.navigate).toHaveBeenCalledWith('index');
  });

  it('uses the same tabPress contract without resetting an inactive tab', () => {
    const { tree, navigation } = renderTabBar();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Showcase' }).props.onPress();
    });

    expect(navigation.emit).toHaveBeenCalledWith({
      type: 'tabPress',
      target: 'showcase-key',
      canPreventDefault: true,
    });
    expect(navigation.navigate).toHaveBeenCalledWith('showcase');
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
