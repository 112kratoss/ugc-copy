// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

// One router object for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
const announce = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  api: { getAppVersion: vi.fn() },
}));

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.8' } } }));

vi.mock('expo-router', () => ({
  router: routerState,
  Stack: { Screen: () => null },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: announce },
  Linking: { openURL: openUrl },
  Platform: { OS: 'ios' },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  RefreshCw: () => null,
  Sparkles: () => null,
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Kicker: ({ children, ...props }: MockProps) => React.createElement('kicker', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/env', () => ({
  env: { appStoreUrl: 'https://apps.apple.com/app/id1', playStoreUrl: 'https://play.google.com/store/apps/details?id=x' },
}));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({ colors: { background: '#fff', faint: '#999', primary: '#f60', selectedStrong: '#fed' } }),
}));

import UpdateRequiredScreen from '../app/update-required';

const trees: renderer.ReactTestRenderer[] = [];

function renderScreen() {
  act(() => {
    trees.push(renderer.create(<UpdateRequiredScreen />));
  });
  return trees.at(-1)!;
}

function checkAgainButton(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'secondary-button');
}

async function pressCheckAgain(tree: renderer.ReactTestRenderer) {
  await act(async () => {
    (checkAgainButton(tree).props.onPress as () => void)();
  });
}

function notices(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => String(node.type) === 'app-text' && node.props.accessibilityLiveRegion === 'polite')
    .map((node) => node.props.children);
}

function policy(minimumAppVersion: string) {
  return {
    buildId: 'build-123',
    mobileCompatibility: {
      currentApiVersion: 1,
      minimumApiVersion: 1,
      minimumAppVersion,
      supportedCatalogSchemaVersions: [1, 2, 3],
      unversionedClientsUseApiVersion: 1,
    },
    criticalUpdate: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
});

// Check again used to open the app's own URL, which expo-router turned into a
// trip to Home without asking the server; Home's first request answered 426 and
// sent the person back (audit 04-10).
describe('the update screen’s Check again', () => {
  it('asks the server and opens Home when this build meets the floor again', async () => {
    authState.api.getAppVersion.mockResolvedValueOnce(policy('0.0.5'));
    const tree = renderScreen();

    await pressCheckAgain(tree);

    expect(authState.api.getAppVersion).toHaveBeenCalledTimes(1);
    expect(routerState.replace).toHaveBeenCalledWith('/');
    expect(notices(tree)).toEqual([]);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('stays and says so when the build is still below the floor', async () => {
    authState.api.getAppVersion.mockResolvedValueOnce(policy('0.2.0'));
    const tree = renderScreen();

    await pressCheckAgain(tree);

    expect(routerState.replace).not.toHaveBeenCalled();
    expect(notices(tree)).toEqual(['Still out of date — update from the store.']);
    expect(announce).toHaveBeenCalledWith('Still out of date — update from the store.');
    expect(checkAgainButton(tree).props.label).toBe('Check again');
    expect(checkAgainButton(tree).props.disabled).toBe(false);
  });

  it('stays without claiming either answer when the check itself fails', async () => {
    authState.api.getAppVersion.mockRejectedValueOnce(new Error('Network request failed'));
    const tree = renderScreen();

    await pressCheckAgain(tree);

    expect(routerState.replace).not.toHaveBeenCalled();
    expect(notices(tree)).toEqual(["We couldn't check for updates. Check your connection and try again."]);
    expect(checkAgainButton(tree).props.disabled).toBe(false);
  });

  it('asks once while a check is out, and clears the last answer when asked again', async () => {
    let answer!: (value: ReturnType<typeof policy>) => void;
    authState.api.getAppVersion
      .mockResolvedValueOnce(policy('0.2.0'))
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const tree = renderScreen();
    await pressCheckAgain(tree);
    expect(notices(tree)).toHaveLength(1);

    await pressCheckAgain(tree);
    expect(checkAgainButton(tree).props.label).toBe('Checking…');
    expect(checkAgainButton(tree).props.disabled).toBe(true);
    expect(notices(tree)).toEqual([]);
    await pressCheckAgain(tree);
    expect(authState.api.getAppVersion).toHaveBeenCalledTimes(2);

    await act(async () => { answer(policy('0.0.5')); });
    expect(routerState.replace).toHaveBeenCalledWith('/');
  });

  it('still sends Open store to this platform’s store', () => {
    const tree = renderScreen();
    const openStore = tree.root.find((node) => String(node.type) === 'primary-button');

    act(() => { (openStore.props.onPress as () => void)(); });

    expect(openUrl).toHaveBeenCalledWith('https://apps.apple.com/app/id1');
  });
});
