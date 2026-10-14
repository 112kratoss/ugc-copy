// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerState = vi.hoisted(() => ({ push: vi.fn() }));
// One stable object per render: a fresh `api` or `user` each call would read as
// a new identity to every effect keyed on it.
const authState = vi.hoisted(() => ({ user: null as { id: string } | null, api: {} }));
const queryState = vi.hoisted(() => ({
  // The Alerts list pages (useInfiniteQuery since #453); signed out it never asks.
  query: { data: undefined, isRefetching: false, isLoading: false, isError: false, error: null, refetch: () => Promise.resolve(), fetchNextPage: () => Promise.resolve(), hasNextPage: false, isFetchingNextPage: false },
  mutation: { mutate: () => undefined, isPending: false, error: null },
  client: {},
}));
const pushState = vi.hoisted(() => ({
  registration: {
    result: null,
    isLoading: false,
    isEnabling: false,
    checkFailed: false,
    enableError: null,
    enable: () => undefined,
    recheck: () => undefined,
  },
}));

vi.mock('expo-router', () => ({ router: routerState }));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Linking: { openSettings: () => Promise.resolve() },
  Platform: { OS: 'ios' },
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => undefined,
  useScrollToTop: () => undefined,
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement('icon', { name, ...props });
  return {
    BellRing: icon('BellRing'),
    CheckCheck: icon('CheckCheck'),
    CheckCircle2: icon('CheckCircle2'),
    Clock3: icon('Clock3'),
    CreditCard: icon('CreditCard'),
    Heart: icon('Heart'),
    RefreshCw: icon('RefreshCw'),
    ToggleLeft: icon('ToggleLeft'),
    ToggleRight: icon('ToggleRight'),
    WandSparkles: icon('WandSparkles'),
  };
});

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  IconButton: (props: MockProps) => React.createElement('icon-button', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/top-scrim', () => ({
  TopScrim: () => null,
}));

vi.mock('@/lib/safe-area', () => ({
  resolvedTopInset: (value: number) => value,
  resolvedBottomInset: (value: number) => value,
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryState.query,
  useInfiniteQuery: () => queryState.query,
  useMutation: () => queryState.mutation,
  useQueryClient: () => queryState.client,
}));

vi.mock('@/lib/push-registration', () => ({
  useDevicePushRegistration: () => pushState.registration,
}));

// The real module registers a notification handler with expo-notifications at
// import; what this screen takes from it is the Alerts route and three seams.
vi.mock('@/lib/notifications', () => ({
  ALERTS_ROUTE: '/studio',
  deepLinkTargetsAlertsScreen: () => false,
  navigateToNotificationDeepLink: () => false,
  setAlertsScreenFocused: () => undefined,
}));

import StudioScreen from '../app/(tabs)/studio';

beforeEach(() => {
  authState.user = null;
  routerState.push.mockClear();
});

describe('Alerts, signed out', () => {
  it('brings the reader back to Alerts after sign-in, not to Home', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StudioScreen />);
    });

    const signIn = tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === 'Sign in');
    renderer.act(() => { (signIn.props.onPress as () => void)(); });

    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/studio' } });
  });
});
