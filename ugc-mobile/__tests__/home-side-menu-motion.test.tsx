// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The drawer builds its Modal and its animated values only outside a test
// environment (`IS_TEST_ENVIRONMENT`, read as the module loads), so this file
// loads it as the app does, with React Native's Animated replaced by nodes a
// test can compare.
vi.hoisted(() => {
  vi.stubEnv('NODE_ENV', 'development');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const motion = vi.hoisted(() => ({
  /** Every spring started, held where it is: none of them finishes on its own. */
  springs: [] as Array<{ value: unknown; toValue: unknown }>,
}));

const container = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const fake = {
    routeKey: 'index-key',
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

vi.mock('expo-router', () => ({ router: { push: vi.fn() }, useNavigationContainerRef: () => container.ref }));

vi.mock('react-native', () => ({
  Animated: {
    View: ({ children, ...props }: MockProps) => React.createElement('animated-view', props, children),
    // Each interpolation and sum is a node of its own, as React Native's are.
    Value: class {
      constructor(private value: number) {}
      setValue(next: number) { this.value = next; }
      stopAnimation() {}
      interpolate(config: unknown) { return { interpolates: this, config }; }
    },
    spring: (value: unknown, config: { toValue: unknown }) => ({
      start: () => {
        motion.springs.push({ value, toValue: config.toValue });
      },
      stop: () => {},
    }),
    add: (a: unknown, b: unknown) => ({ add: [a, b] }),
  },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Modal: ({ children, visible }: MockProps & { visible?: boolean }) => (
    visible ? React.createElement('modal', null, children) : null
  ),
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement(name, props);
  return {
    BadgeCheck: icon('badge-check-icon'),
    ChevronRight: icon('chevron-right-icon'),
    CircleHelp: icon('circle-help-icon'),
    Crown: icon('crown-icon'),
    Gift: icon('gift-icon'),
    Layers3: icon('layers-icon'),
    LayoutDashboard: icon('layout-dashboard-icon'),
    LogIn: icon('log-in-icon'),
    LogOut: icon('log-out-icon'),
    PackageOpen: icon('package-open-icon'),
    Settings: icon('settings-icon'),
    Sparkles: icon('sparkles-icon'),
    Wallet: icon('wallet-icon'),
    X: icon('x-icon'),
  };
});

vi.mock('@/components/sheet-chrome', () => ({ SHEET_DISMISS_DISTANCE: 100, SHEET_DISMISS_VELOCITY: 0.6 }));
vi.mock('@/components/ui', () => ({
  BrandLockup: () => React.createElement('brand-lockup'),
  IconButton: (props: Record<string, unknown>) => React.createElement('icon-button', props),
}));
vi.mock('@/lib/dialog', () => ({ showMessageDialog: vi.fn() }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => false }));
vi.mock('@/lib/platform-glyphs', () => ({
  CloseGlyph: (props: Record<string, unknown>) => React.createElement('close-glyph', props),
}));
vi.mock('@/lib/safe-area', () => ({
  resolvedTopInset: (inset: number) => inset,
  resolvedBottomInset: (inset: number) => inset,
}));

import { HomeSideMenu } from '../components/home-side-menu';

function menuElement({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <HomeSideMenu
      visible={visible}
      onClose={onClose}
      user={{ id: 'user-1', email: 'luna@example.com', user_metadata: {} } as never}
      profile={{ displayName: 'Luna Dreams', username: 'luna-dreams' } as never}
      credits={1200}
      totalSalesUsdCents={1250}
      onSignOut={async () => undefined}
    />
  );
}

function animatedView(tree: renderer.ReactTestRenderer, match: (props: Record<string, unknown>) => boolean) {
  return tree.root.find((node) => String(node.type) === 'animated-view' && match(node.props));
}

beforeEach(() => {
  container.routeKey = 'index-key';
  container.listeners.clear();
  motion.springs = [];
});

/**
 * Review of #679, B2: a row hands off to its screen and the drawer slides out
 * over it once it has been built; the owner's close re-renders the drawer a
 * render after that slide has begun. Built on every render, the slide's and the
 * scrim's nodes were built again there, mid-exit, and connected to the views
 * again under the running slide: the cause read from the film of the drawer
 * drawn from the root, which stopped for 72 ms on its way out (cbdf763ae).
 */
describe('HomeSideMenu motion', () => {
  it("keeps the nodes its slide and scrim run on through its owner's late close", () => {
    const onClose = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(menuElement({ visible: true, onClose }));
    });
    const nodes = () => ({
      slide: (animatedView(tree, (props) => props.accessibilityViewIsModal === true).props.style as {
        transform: Array<{ translateX: unknown }>;
      }).transform[0].translateX,
      scrim: (animatedView(tree, (props) => props.importantForAccessibility === 'no-hide-descendants').props.style as {
        opacity: unknown;
      }).opacity,
    });
    const opened = nodes();

    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Settings')
        .props.onPress();
    });
    renderer.act(() => container.land('settings-key'));

    // The slide out has begun, and the owner has been told to close.
    expect(motion.springs[motion.springs.length - 1]?.toValue).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);

    // The owner's close, with the drawer still on its way out.
    renderer.act(() => {
      tree.update(menuElement({ visible: false, onClose }));
    });

    expect(nodes().slide).toBe(opened.slide);
    expect(nodes().scrim).toBe(opened.scrim);
  });
});
