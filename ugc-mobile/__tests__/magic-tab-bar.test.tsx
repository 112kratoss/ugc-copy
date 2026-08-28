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
  ArrowLeft: (props: Record<string, unknown>) => React.createElement('glyph-icon', props),
  ChevronLeft: (props: Record<string, unknown>) => React.createElement('glyph-icon', props),
  Share: (props: Record<string, unknown>) => React.createElement('glyph-icon', props),
  Share2: (props: Record<string, unknown>) => React.createElement('glyph-icon', props),
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
      borderStrong: 'rgba(255,248,237,0.22)',
      badge: '#ff3b30',
      onBadge: '#ffffff',
    },
    icon: { feature: 24 },
  },
}));

// The badge's own rules (red oval, white text, 99+ cap, one badged tab) are
// swept in hig-navigation-chrome.test.ts. Here the count is just an input, so
// the hook is stubbed rather than dragging an auth provider and a query client
// into a test about tab presses. `badgeValue` lets a case opt into a badge.
let badgeValue: string | null = null;
vi.mock('@/lib/use-notification-badge', () => ({
  useTabBarBadge: () => badgeValue,
  useUnreadNotificationCount: () => 0,
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

/**
 * Alpha of the frost lift inside a translucent surface. Identified by its
 * geometry — a full-bleed absolute fill — rather than by its colour or its
 * position among the children, so it stays findable when the palette moves.
 * The badge oval is absolute too but insets itself, which is what the
 * four-sided check rules out.
 */
function frostLiftAlpha(surface: renderer.ReactTestInstance) {
  const lift = surface.findByProps({ testID: 'tab-bar-frost-lift' });

  const color = (lift.props.style as Record<string, unknown>).backgroundColor as string;
  return Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(color)?.[1]);
}

function adaptiveFallbacks(tree: ReturnType<typeof renderer.create>) {
  // Host elements only: the react-native mock renders each primitive through a
  // function component, so matching on the testID alone counts every surface twice.
  return tree.root.findAll(
    (node) => String(node.type) === 'view' && node.props.testID === 'tab-bar-adaptive-surface'
  );
}

/**
 * The dock's colour lives on two stacked opaque layers rather than on one fill:
 * the outgoing colour paints the surface and the incoming one fades in over it.
 * Reading both is how a test can tell "the bar is this colour" apart from "the
 * bar is mid-transition", which a single `backgroundColor` could not express.
 */
function adaptiveLayers(tree: ReturnType<typeof renderer.create>) {
  const [surface] = adaptiveFallbacks(tree);
  const incoming = surface.findByProps({ testID: 'tab-bar-adaptive-fill' });
  return {
    outgoing: (surface.props.style as Record<string, unknown>).backgroundColor as string,
    incoming: (incoming.props.style as Record<string, unknown>).backgroundColor as string,
  };
}

describe('MagicTabBar', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    glassState.available = false;
    glassState.reduceTransparency = false;
    badgeValue = null;
  });

  it('hides by going invisible and inert without changing the surface tree', async () => {
    const { tree } = await renderTabBarAsync(0, { hidden: true });

    expect(adaptiveFallbacks(tree)).toHaveLength(1);

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

  it('swaps the adaptive fallback for Liquid Glass when the OS supports it', async () => {
    glassState.available = true;

    const { tree } = await renderTabBarAsync();

    expect(tree.root.findAll((node) => String(node.type) === 'glass-view')).toHaveLength(1);
    expect(adaptiveFallbacks(tree)).toHaveLength(0);
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

    // Darkening is not the only way to flatten the material. The frost lift
    // brightens it, and a bright enough lift milks it into the same slab from
    // the other direction — so it gets bounded here too, and against the tint
    // rather than a bare number: the pair only reads as glass while the cap
    // still leads the lift.
    const liftAlpha = frostLiftAlpha(glass);
    expect(liftAlpha).toBeGreaterThan(0);
    expect(liftAlpha).toBeLessThan(tintAlpha);
  });

  it('uses a fully opaque adaptive panel when Liquid Glass is unavailable', async () => {
    const { tree } = await renderTabBarAsync();

    expect(tree.root.findAll((node) => String(node.type) === 'blur-view')).toHaveLength(0);
    const [fallback] = adaptiveFallbacks(tree);
    expect(fallback).toBeTruthy();

    // Both tint layers are opaque hex. An `rgba` fill on either one would let
    // the feed show through unblurred, which is the look the opaque dock exists
    // to avoid — and would put the label contrast beyond anything the cap can
    // guarantee, since it would then depend on the media rather than the fill.
    const { outgoing, incoming } = adaptiveLayers(tree);
    expect(outgoing).toMatch(/^#[\da-f]{6}$/i);
    expect(incoming).toMatch(/^#[\da-f]{6}$/i);
    expect(fallback.findAllByProps({ testID: 'tab-bar-frost-lift' })).toHaveLength(0);
  });

  it('paints both cross-fade layers the same colour when nothing is adapting', async () => {
    const { tree } = await renderTabBarAsync();
    const { outgoing, incoming } = adaptiveLayers(tree);

    expect(outgoing).toBe('#1f1f24');
    expect(incoming).toBe(outgoing);
  });

  /**
   * The shade is lighting, never tint. Its predecessor was a five-stop
   * horizontal ramp built from the media colour with a hard dark stop at 0.52,
   * which landed a shadow directly under the raised Create button and read as a
   * rendering artifact. Keeping it vertical and free of any opaque stop is what
   * stops the gradient having a say in what colour the bar is.
   */
  it('keeps the depth shade vertical, translucent and independent of the tint', async () => {
    const { tree } = await renderTabBarAsync();
    const shade = tree.root.findByProps({ testID: 'tab-bar-adaptive-shade' });

    expect(shade.props.start).toEqual({ x: 0.5, y: 0 });
    expect(shade.props.end).toEqual({ x: 0.5, y: 1 });
    expect((shade.props.colors as string[]).every((color) => color.startsWith('rgba('))).toBe(true);
  });

  it('keeps the fallback background uniform across the complete pill', async () => {
    const { tree } = await renderTabBarAsync();

    const [fallback] = adaptiveFallbacks(tree);
    const style = fallback.props.style as Record<string, unknown>;
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBe('rgba(255,248,237,0.12)');
    expect(fallback.findAll((node) => typeof node.props.onLayout === 'function')).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'linear-gradient')).toHaveLength(1);
  });

  it('keeps the area around the floating adaptive surface transparent', async () => {
    const adaptiveMode = await renderTabBarAsync();
    const gradients = adaptiveMode.tree.root.findAll((node) => String(node.type) === 'linear-gradient');
    expect(gradients).toHaveLength(1);

    glassState.available = true;
    const glassMode = await renderTabBarAsync();
    expect(
      glassMode.tree.root.findAll((node) => String(node.type) === 'linear-gradient')
    ).toHaveLength(0);

    glassState.reduceTransparency = true;
    const solidMode = await renderTabBarAsync();
    expect(
      solidMode.tree.root.findAll((node) => String(node.type) === 'linear-gradient')
    ).toHaveLength(0);
  });

  it('uses only icon and label colour to mark the selected tab', async () => {
    const { tree } = await renderTabBarAsync();
    const home = tree.root.findByProps({ accessibilityLabel: 'Home' });

    expect(home.findByType('home-icon' as never).props.color).toBe('#FF7A59');
    expect(
      home.findAll((node) => {
        const style = node.props.style as Record<string, unknown> | undefined;
        return style?.width === 18 && style?.height === 3 && style?.backgroundColor === '#FF7A59';
      })
    ).toHaveLength(0);
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
    expect(glassIcon.props.color).toBe('rgba(255,255,255,0.88)');
  });

  it('drops to a genuinely opaque bar when Reduce Transparency is on', async () => {
    glassState.available = true;
    glassState.reduceTransparency = true;

    const { tree } = await renderTabBarAsync();

    // Neither effect surface should render: this branch exists for users who
    // asked for less see-through, so it must not quietly stay translucent.
    expect(tree.root.findAll((node) => String(node.type) === 'glass-view')).toHaveLength(0);
    expect(adaptiveFallbacks(tree)).toHaveLength(0);

    const opaque = tree.root.findAll((node) => {
      const style = node.props.style as Record<string, unknown> | undefined;
      return node.type === 'view' && style?.backgroundColor === '#111215';
    });
    expect(opaque).toHaveLength(1);
  });

  it('keeps the bottom safe-area continuation transparent under the restored nav', () => {
    const { tree } = renderTabBar();

    expect(adaptiveFallbacks(tree)).toHaveLength(1);

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

function findBadgeOvals(tree: ReturnType<typeof renderer.create>) {
  return tree.root.findAll((node) => {
    const style = node.props.style as Record<string, unknown> | undefined;
    return node.type === 'view' && style?.backgroundColor === '#ff3b30';
  });
}

  it('draws no badge on a tab with nothing unread', () => {
    const { tree } = renderTabBar();

    expect(tree.root.findByProps({ accessibilityLabel: 'Alerts' })).toBeTruthy();
    expect(findBadgeOvals(tree)).toHaveLength(0);
  });

  it('badges the Alerts tab and says the count out loud', () => {
    badgeValue = '3';
    const { tree } = renderTabBar();

    // HIG asks for a red oval containing the count; VoiceOver gets it through
    // the tab's own label, because the oval itself is hidden from the reader.
    expect(findBadgeOvals(tree)).toHaveLength(1);
    expect(tree.root.findByProps({ accessibilityLabel: 'Alerts, 3 unread' })).toBeTruthy();
    expect(tree.root.findAll((node) => node.props?.accessibilityLabel === 'Alerts')).toHaveLength(0);
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
