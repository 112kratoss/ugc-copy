// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const routerState = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('expo-router', () => ({ router: routerState }));

// Under test the drawer draws without its Modal or animation (IS_TEST_ENVIRONMENT).
vi.mock('react-native', () => ({
  Animated: {},
  BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Modal: ({ children }: MockProps) => React.createElement('modal', null, children),
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
vi.mock('@/components/ui', () => ({ BrandLockup: () => React.createElement('brand-lockup') }));
vi.mock('@/lib/dialog', () => ({ showMessageDialog: vi.fn() }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/platform-glyphs', () => ({
  CloseGlyph: (props: Record<string, unknown>) => React.createElement('close-glyph', props),
}));
vi.mock('@/lib/safe-area', () => ({
  resolvedTopInset: (inset: number) => inset,
  resolvedBottomInset: (inset: number) => inset,
}));

import { HomeSideMenu } from '../components/home-side-menu';

function renderMenu(totalSalesUsdCents: number | null) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <HomeSideMenu
        visible
        onClose={vi.fn()}
        user={{ id: 'user-1', email: 'luna@example.com', user_metadata: {} } as never}
        profile={{ displayName: 'Luna Dreams', username: 'luna-dreams' } as never}
        credits={1200}
        totalSalesUsdCents={totalSalesUsdCents}
        onSignOut={async () => undefined}
      />,
    );
  });
  return tree;
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => node.type === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

function earningsCard(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => node.type === 'view'
    && typeof node.props.accessibilityLabel === 'string'
    && node.props.accessibilityLabel.startsWith('Tracked earnings'));
}

/**
 * 03-2 / 10-08 DONE 12: the menu called the lifetime earnings "Total sales", a
 * count's word on a dollar figure, after Your Sales had renamed the same number
 * "Tracked earnings". It is not the Wallet's withdrawable balance either.
 */
describe('HomeSideMenu earnings', () => {
  it('calls the dollar figure "Tracked earnings", as Your Sales does', () => {
    const tree = renderMenu(1250);

    expect(texts(tree)).toEqual(expect.arrayContaining(['Tracked earnings', '$12.50']));
    expect(texts(tree)).not.toContain('Total sales');
    expect(earningsCard(tree).props.accessibilityLabel).toBe('Tracked earnings $12.50');
  });

  it('prints whole dollars with their cents', () => {
    const tree = renderMenu(500);

    expect(texts(tree)).toContain('$5.00');
    expect(earningsCard(tree).props.accessibilityLabel).toBe('Tracked earnings $5.00');
  });

  it('draws a dash, never $0, until the profile answers', () => {
    const tree = renderMenu(null);

    expect(texts(tree)).toEqual(expect.arrayContaining(['Tracked earnings', '–']));
    expect(texts(tree).some((text) => text.startsWith('$'))).toBe(false);
    expect(earningsCard(tree).props.accessibilityLabel).toBe('Tracked earnings loading');
  });
});

// Recipe audit B-F9: the buyer's library was "Your Recipes", which read like
// the recipes they made, under "Recipe Sales"; the web called it "Unlocks".
describe('HomeSideMenu library row', () => {
  it('calls the buyer\'s library "Unlocked recipes" and opens it', () => {
    routerState.push.mockClear();
    const tree = renderMenu(1250);

    expect(texts(tree)).toContain('Unlocked recipes');
    expect(texts(tree)).not.toContain('Your Recipes');
    const row = tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Unlocked recipes');
    renderer.act(() => row.props.onPress());
    expect(routerState.push).toHaveBeenCalledWith('/unlocks');
  });
});

