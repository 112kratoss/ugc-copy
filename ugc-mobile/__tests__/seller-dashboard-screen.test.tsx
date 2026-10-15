// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

// One router object for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  canGoBack: vi.fn(() => true),
}));

const authState = vi.hoisted(() => ({
  api: { listOwnerPosts: vi.fn() },
  user: null as { id: string; email: string } | null,
}));

const listings = vi.hoisted(() => ({
  options: null as null | { enabled: boolean },
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (options: { enabled: boolean }) => {
    listings.options = options;
    return {
      data: undefined,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      refetch: vi.fn(),
    };
  },
}));

vi.mock('expo-router', () => ({ router: routerState }));

vi.mock('react-native', () => ({
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  BarChart3: () => null,
  ChevronRight: () => null,
  DollarSign: () => null,
  PackageCheck: () => null,
}));

vi.mock('@/components/skeleton', () => ({ CardListSkeleton: () => null }));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/home-view-model', () => ({
  formatUsdCents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
  getOwnerPostSalesSummary: () => ({ earningsUsdCents: 0, salesCount: 0, listingCount: 0 }),
}));
vi.mock('@/lib/theme', () => ({
  appTheme: { icon: { feature: 22 }, opacity: { pressed: 0.7 }, spacing: { gap: 12 } },
}));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({ colors: { commerce: '#0a0', faint: '#999', info: '#08f', primary: '#f60', success: '#0a0', surface: '#eee' } }),
}));

import SellerDashboardScreen from '../app/seller-dashboard';

const trees: renderer.ReactTestRenderer[] = [];

function renderScreen() {
  act(() => {
    trees.push(renderer.create(<SellerDashboardScreen />));
  });
  return trees.at(-1)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = null;
  listings.options = null;
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
});

// Signing in from Your Sales ended on Home (audit 01-12).
describe('Your Sales, signed out', () => {
  it('signs in back to Your Sales', () => {
    const tree = renderScreen();
    const signIn = tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === 'Sign in');

    act(() => { (signIn.props.onPress as () => void)(); });

    expect(routerPush()).toEqual([{ pathname: '/auth', params: { returnTo: '/seller-dashboard' } }]);
    // Nothing of the account is read for a visitor.
    expect(listings.options?.enabled).toBe(false);
  });
});

function routerPush() {
  return routerState.push.mock.calls.map(([href]) => href);
}
