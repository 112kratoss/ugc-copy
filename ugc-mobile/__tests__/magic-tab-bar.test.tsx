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

/**
 * The navigation container as the create menu's hand-off reads it
 * (`lib/menu-handoff.ts`): the focused route, and the `state` event the real
 * container emits once a navigation has been committed. `land` is that event.
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

const glassState = vi.hoisted(() => ({
  available: false,
  reduceTransparency: false,
  platform: 'ios',
  listeners: [] as string[],
}));

vi.mock('expo-router', () => ({
  router: routerState,
  useNavigationContainerRef: () => container.ref,
}));

vi.mock('react-native', () => ({
  Platform: { get OS() { return glassState.platform; } },
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
    addEventListener: (...args: unknown[]) => {
      glassState.listeners.push(String(args[0]));
      return { remove: () => {} };
    },
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
  Compass: (props: Record<string, unknown>) => React.createElement('compass-icon', props),
  Bell: (props: Record<string, unknown>) => React.createElement('bell-icon', props),
  Users: (props: Record<string, unknown>) => React.createElement('users-icon', props),
  FilePlus2: (props: Record<string, unknown>) => React.createElement('file-plus-icon', props),
  Home: (props: Record<string, unknown>) => React.createElement('home-icon', props),
  Plus: (props: Record<string, unknown>) => React.createElement('plus-icon', props),
  Sparkles: (props: Record<string, unknown>) => React.createElement('sparkles-icon', props),
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

// The real theme: it is plain data with no native imports, and the bar now
// reads its materials per scheme (`theme.tabBar`), so a hand-cut subset of the
// palette would have to track every token the bar touches. With no provider
// mounted, `useAppTheme()` answers with the dark theme.

// The badge's own rules (red oval, white text, 99+ cap, one badged tab) are
// swept in hig-navigation-chrome.test.ts. Here the count is just an input, so
// the hook is stubbed rather than dragging an auth provider and a query client
// into a test about tab presses. `badgeValue` lets a case opt into a badge.
let badgeValue: string | null = null;
vi.mock('@/lib/use-notification-badge', () => ({
  useTabBarBadge: () => badgeValue,
  useUnreadNotificationCount: () => 0,
}));

// Same seam, same reason: the real hook reaches `useAuth` and boots the native
// chain behind it, and this file is about what the bar renders.
let runningGenerations = 0;
vi.mock('@/lib/use-active-generations', () => ({
  useTabBarGenerationCount: () => runningGenerations,
  useActiveGenerationCount: () => runningGenerations,
}));

import { MagicCreateMenu } from '../components/magic-create-menu';
import { MagicTabBar } from '../components/magic-tab-bar';
import { appTheme, themes } from '../lib/theme';

const routes = [
  { key: 'home-key', name: 'index' },
  { key: 'showcase-key', name: 'showcase' },
  { key: 'creator-key', name: 'creator' },
  { key: 'studio-key', name: 'studio' },
  { key: 'profile-key', name: 'profile' },
];

function renderTabBar(activeIndex = 0, { hidden = false }: { hidden?: boolean } = {}) {
  container.routeKey = routes[activeIndex].key;
  const navigation = {
    emit: vi.fn(() => ({ defaultPrevented: false })),
    navigate: vi.fn(),
    // The real container's store takes a jump at once; its `state` event comes
    // after the commit, which a jump's hand-off does not wait for.
    jumpTo: vi.fn((name: string) => {
      container.routeKey = routes.find((route) => route.name === name)?.key ?? name;
    }),
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
    container.listeners.clear();
    glassState.available = false;
    glassState.reduceTransparency = false;
    glassState.platform = 'ios';
    glassState.listeners = [];
    badgeValue = null;
    runningGenerations = 0;
  });

  it('keeps Android navigation opaque and routes every destination through tabPress', async () => {
    glassState.platform = 'android';
    badgeValue = '3';
    const { tree, navigation } = await renderTabBarAsync(1);
    expect(tree.root.findByProps({ testID: 'android-navigation-dock' })).toBeTruthy();
    expect(adaptiveFallbacks(tree)).toHaveLength(0);
    // The iOS surfaces are the only consumers of Reduce Transparency, so the
    // dock does not subscribe to a preference it cannot spend. Reduce Motion is
    // a different matter: the capsule and the press swell both answer to it.
    expect(glassState.listeners).not.toContain('reduceTransparencyChanged');
    expect(glassState.listeners).toContain('reduceMotionChanged');
    for (const [label, route, key] of [
      ['Home', 'index', 'home-key'],
      ['Explore', 'showcase', 'showcase-key'],
      ['Alerts, 3 unread', 'studio', 'studio-key'],
      ['Profile', 'profile', 'profile-key'],
    ]) {
      const tab = tree.root.findByProps({ accessibilityLabel: label });
      expect(tab.props.accessibilityState.selected).toBe(route === 'showcase');
      renderer.act(() => tab.props.onPress());
      expect(navigation.emit).toHaveBeenLastCalledWith({ type: 'tabPress', target: key, canPreventDefault: true });
      expect(navigation.navigate).toHaveBeenLastCalledWith(route);
    }
    renderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.onPress());
    expect(navigation.jumpTo).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ accessibilityLabel: 'Post' })).toBeTruthy();
    renderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Generate' }).props.onPress());
    expect(navigation.emit).toHaveBeenLastCalledWith({ type: 'tabPress', target: 'creator-key', canPreventDefault: true });
    expect(navigation.jumpTo).toHaveBeenCalledWith('creator');
  });

  it('rings the create control only while runs are in flight, and says so', async () => {
    glassState.platform = 'android';
    const idle = await renderTabBarAsync(0);
    expect(idle.tree.root.findAllByProps({ testID: 'generation-ring' })).toHaveLength(0);
    expect(idle.tree.root.findByProps({ accessibilityLabel: 'Open create menu' })).toBeTruthy();

    runningGenerations = 2;
    const busy = await renderTabBarAsync(0);
    expect(busy.tree.root.findAllByProps({ testID: 'generation-ring' }).length).toBeGreaterThan(0);
    // A spinning arc with nothing said about it is a decoration; the label is
    // where the state actually reaches a screen reader.
    const control = busy.tree.root.findByProps({
      accessibilityLabel: 'Open create menu, 2 creations in progress',
    });
    expect(control.props.accessibilityState.busy).toBe(true);
  });

  it('counts one run in the singular', async () => {
    glassState.platform = 'android';
    runningGenerations = 1;
    const { tree } = await renderTabBarAsync(0);
    expect(tree.root.findByProps({
      accessibilityLabel: 'Open create menu, 1 creation in progress',
    })).toBeTruthy();
  });

  it.each([
    ['Liquid Glass', true],
    ['the adaptive bar', false],
  ])('rings the iOS create disc the same way over %s, beside the disc rather than inside the material', async (_surface, glass) => {
    // The ring and its label arrived with the Android dock, and the iOS disc
    // went on running the count's poll with nothing to show for it.
    glassState.platform = 'ios';
    glassState.available = glass;
    const idle = await renderTabBarAsync(0);
    expect(idle.tree.root.findAllByProps({ testID: 'generation-ring' })).toHaveLength(0);
    const idleDisc = idle.tree.root.findByProps({ accessibilityLabel: 'Open create menu' });
    expect(idleDisc.props.accessibilityState).toEqual({ expanded: false, busy: false });

    runningGenerations = 2;
    const busy = await renderTabBarAsync(0);
    expect(busy.tree.root.findAllByProps({ testID: 'android-navigation-dock' })).toHaveLength(0);
    const disc = busy.tree.root.findByProps({ accessibilityLabel: 'Open create menu, 2 creations in progress' });
    expect(disc.props.accessibilityState.busy).toBe(true);
    const rings = busy.tree.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'generation-ring');
    expect(rings).toHaveLength(1);
    // Held with the disc alone: the nearest control around the ring is Create,
    // not the row of tabs inside the bar's surface.
    const pressablesIn = (node: renderer.ReactTestInstance) => node.findAll((child) => String(child.type) === 'pressable');
    let holder = rings[0].parent;
    while (holder && pressablesIn(holder).length === 0) holder = holder.parent;
    expect(pressablesIn(holder!).map((node) => node.props.accessibilityLabel)).toEqual(['Open create menu, 2 creations in progress']);
    const surface = glass
      ? busy.tree.root.find((node) => String(node.type) === 'glass-view')
      : adaptiveFallbacks(busy.tree)[0];
    expect(surface.findAllByProps({ testID: 'generation-ring' })).toHaveLength(0);
  });

  it('keeps the Android dock inert when hidden and respects prevented tab presses', async () => {
    glassState.platform = 'android';
    const { tree, navigation } = await renderTabBarAsync(0, { hidden: true });
    const root = tree.root.findAll((node) => String(node.type) === 'view')[0];
    expect(root.props.pointerEvents).toBe('none');
    expect(root.props.importantForAccessibility).toBe('no-hide-descendants');
    navigation.emit.mockReturnValue({ defaultPrevented: true });
    renderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Profile' }).props.onPress());
    expect(navigation.navigate).not.toHaveBeenCalled();
    renderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.onPress());
    renderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Generate' }).props.onPress());
    expect(navigation.jumpTo).not.toHaveBeenCalled();
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
    // The dock and the disc take their touches; the bar's empty strips pass
    // theirs on to the screen beneath, as they did while the view was flattened.
    expect(root.props.pointerEvents).toBe('box-none');
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

    expect(home.findByType('home-icon' as never).props.color).toBe(themes.dark.colors.primary);
    expect(
      home.findAll((node) => {
        const style = node.props.style as Record<string, unknown> | undefined;
        return style?.width === 18 && style?.height === 3 && style?.backgroundColor === themes.dark.colors.primary;
      })
    ).toHaveLength(0);
  });

  it('brightens the inactive labels on translucent surfaces only', async () => {
    glassState.reduceTransparency = true;
    const solid = await renderTabBarAsync();
    const solidIcon = solid.tree.root
      .findByProps({ accessibilityLabel: 'Explore' })
      .findByType('compass-icon' as never);

    glassState.reduceTransparency = false;
    glassState.available = true;
    const glass = await renderTabBarAsync();
    const glassIcon = glass.tree.root
      .findByProps({ accessibilityLabel: 'Explore' })
      .findByType('compass-icon' as never);

    // Muted grey is safe against a known opaque bar. Once the surface is
    // translucent the backdrop is whatever post scrolled past, so the label has
    // to carry itself.
    expect(solidIcon.props.color).toBe(themes.dark.colors.muted);
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
      tree.root.findByProps({ accessibilityLabel: 'Explore' }).props.onPress();
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

    expect(tree.root.findByProps({ accessibilityLabel: 'Generate' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Post' })).toBeTruthy();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Close create menu' }).props.onPress();
    });

    expect(() => tree.root.findByProps({ accessibilityLabel: 'Generate' })).toThrow();
  });

  it('keeps Generate routed to the existing creator tab', () => {
    const { tree, navigation } = renderTabBar();

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.onPress();
    });
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Generate' }).props.onPress();
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

/**
 * The menu's tiles hand off to their screens at the tap (`lib/menu-handoff.ts`).
 * They used to wait for the menu's exit, or a 400 ms fallback, before
 * navigating: Generate reached the creator ~560 ms after the tap, with Profile
 * showing in between (Pixel 9a emulator, 2026-11-03).
 */
describe('MagicTabBar create menu hand-off', () => {
  beforeEach(() => {
    routerState.push.mockClear();
    container.listeners.clear();
    glassState.platform = 'ios';
    badgeValue = null;
    runningGenerations = 0;
  });

  const menuOpen = (tree: ReturnType<typeof renderer.create>) => (
    tree.root.findAllByProps({ accessibilityLabel: 'Close create menu' }).length > 0
  );
  const tile = (tree: ReturnType<typeof renderer.create>, label: string) => (
    tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label)
  );
  const openMenu = (tree: ReturnType<typeof renderer.create>) => {
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.onPress();
    });
  };

  it('keeps the menu under one native bar view while Generate hides the bar', () => {
    // Fabric flattens a view with nothing to draw and gives it a native view
    // again once it has opacity, pointer or accessibility props, moving its
    // children; a Modal host moved off the window dismisses its window. Shown,
    // the bar's root had none of those, so hiding it for the creator took the
    // menu's window down mid hand-off (Pixel 9a emulator, 2026-11-03: two
    // frames of bare Profile, then the sheet back for one frame). A test
    // renderer does not flatten: the pin is on the prop that stops it.
    const { tree, navigation } = renderTabBar(4);
    const barRoot = () => tree.root.findAll((node) => String(node.type) === 'view')[0];
    expect(barRoot().props.collapsable).toBe(false);
    openMenu(tree);

    renderer.act(() => tile(tree, 'Generate').props.onPress());
    // The layout hides the bar once the creator is focused.
    renderer.act(() => {
      tree.update(
        <MagicTabBar
          state={{ index: 2, key: 'tabs-key', routeNames: routes.map((route) => route.name), routes, stale: false, type: 'tab', history: [] } as never}
          descriptors={{} as never}
          navigation={navigation as never}
          insets={{ top: 0, right: 0, bottom: 0, left: 0 }}
          hidden
        />
      );
    });

    expect(barRoot().props.collapsable).toBe(false);
    expect((barRoot().props.style as Record<string, unknown>).opacity).toBe(0);
  });

  it('jumps to the creator at the tap and leaves in the same render', () => {
    const { tree, navigation } = renderTabBar(4);
    openMenu(tree);

    renderer.act(() => tile(tree, 'Generate').props.onPress());

    // Not after an exit or a timer: the jump and the menu's exit are one commit.
    expect(navigation.jumpTo).toHaveBeenCalledWith('creator');
    expect(menuOpen(tree)).toBe(false);
    expect(tree.root.findByProps({ accessibilityLabel: 'Open create menu' }).props.accessibilityState.expanded).toBe(false);
  });

  it('pushes the composer at the tap and stays, Post held, until the composer is built under it', () => {
    const { tree } = renderTabBar(4);
    openMenu(tree);

    renderer.act(() => tile(tree, 'Post').props.onPress());

    expect(routerState.push).toHaveBeenCalledWith('/post/new');
    // expo-router builds the pushed screen a render after the tap: until then
    // the menu covers the screen it was opened over, the tapped tile still lit.
    expect(menuOpen(tree)).toBe(true);
    expect(tile(tree, 'Post').props.style.opacity).toBe(appTheme.opacity.pressed);
    expect(tile(tree, 'Generate').props.style.opacity).toBe(1);

    renderer.act(() => container.land('post-new-key'));

    expect(menuOpen(tree)).toBe(false);
    // Post stays lit through the exit: the menu leaves as it was tapped.
    const menu = tree.root.findByType(MagicCreateMenu);
    expect(menu.props.visible).toBe(false);
    expect(menu.props.chosen).toBe('post');
  });

  it('leaves at once when a listener prevents the jump', () => {
    const { tree, navigation } = renderTabBar(4);
    navigation.emit.mockReturnValue({ defaultPrevented: true });
    openMenu(tree);

    renderer.act(() => tile(tree, 'Generate').props.onPress());

    expect(navigation.jumpTo).not.toHaveBeenCalled();
    // Nothing is coming to take over: no wait for the fallback.
    expect(menuOpen(tree)).toBe(false);
  });

  it('opens one screen for two quick taps', () => {
    const { tree, navigation } = renderTabBar(4);
    openMenu(tree);

    const post = tile(tree, 'Post');
    const generate = tile(tree, 'Generate');
    renderer.act(() => {
      // Both delivered before React renders the first: the second finds the
      // menu's one choice taken.
      post.props.onPress();
      post.props.onPress();
      generate.props.onPress();
    });

    expect(routerState.push).toHaveBeenCalledTimes(1);
    expect(navigation.jumpTo).not.toHaveBeenCalled();
  });

  it('listens to the navigator only while a hand-off waits', () => {
    const { tree } = renderTabBar(4);
    openMenu(tree);
    // Mounted for as long as the tabs are: every navigation in the app would
    // otherwise render the bar.
    expect(container.listeners.size).toBe(0);

    renderer.act(() => tile(tree, 'Post').props.onPress());
    expect(container.listeners.size).toBe(1);

    renderer.act(() => container.land('post-new-key'));
    expect(container.listeners.size).toBe(0);
  });

  it('leaves anyway when nothing takes over', () => {
    vi.useFakeTimers();
    try {
      const { tree } = renderTabBar(4);
      openMenu(tree);

      renderer.act(() => tile(tree, 'Post').props.onPress());
      expect(menuOpen(tree)).toBe(true);

      renderer.act(() => {
        vi.advanceTimersByTime(399);
      });
      expect(menuOpen(tree)).toBe(true);
      renderer.act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(menuOpen(tree)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens fresh after a hand-off, with nothing held from the last one', () => {
    const { tree } = renderTabBar(4);
    openMenu(tree);
    renderer.act(() => tile(tree, 'Post').props.onPress());
    renderer.act(() => container.land('post-new-key'));
    // Back from the composer: the tabs are in front again.
    renderer.act(() => container.land('profile-key'));
    expect(menuOpen(tree)).toBe(false);

    openMenu(tree);
    expect(menuOpen(tree)).toBe(true);
    expect(tile(tree, 'Post').props.style.opacity).toBe(1);

    renderer.act(() => tile(tree, 'Post').props.onPress());
    expect(routerState.push).toHaveBeenCalledTimes(2);
  });
});
