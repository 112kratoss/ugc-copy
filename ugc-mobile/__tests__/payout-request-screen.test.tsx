// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

// One router and one navigation for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  canGoBack: vi.fn(() => true),
}));
const navigationState = vi.hoisted(() => ({
  dispatch: vi.fn(),
  prevent: false,
  onPrevent: null as null | ((event: { data: { action: unknown } }) => void),
}));
const queryClient = vi.hoisted(() => ({ invalidateQueries: vi.fn(async () => undefined) }));
const authState = vi.hoisted(() => ({
  api: { requestCreatorPayout: vi.fn() },
  user: null as { id: string } | null,
}));
const payout = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
}));
const dialog = vi.hoisted(() => ({ showConfirmDialog: vi.fn() }));
const announce = vi.hoisted(() => ({ announceQueued: vi.fn() }));

vi.mock('@react-navigation/native', () => ({
  useNavigation: () => navigationState,
  usePreventRemove: (prevent: boolean, callback: (event: { data: { action: unknown } }) => void) => {
    navigationState.prevent = prevent;
    navigationState.onPrevent = callback;
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('expo-router', () => ({
  router: routerState,
  Stack: { Screen: (props: MockProps) => React.createElement('stack-screen', props) },
}));
vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  AppTextInput: (props: MockProps) => React.createElement('app-text-input', props),
  ChoiceChip: (props: MockProps) => React.createElement('choice-chip', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));
vi.mock('@/lib/accessibility-announcement', () => announce);
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/dialog', () => dialog);
vi.mock('@/lib/home-view-model', () => ({
  formatUsdCents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
}));
vi.mock('@/lib/profile-view-model', () => ({ WALLET_UNAVAILABLE_CAPTION: 'Balance unavailable' }));
vi.mock('@/lib/use-creator-payout-state', () => ({
  CREATOR_PAYOUTS_QUERY_KEY: 'creator-payouts',
  useCreatorPayoutState: () => payout.result,
}));

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import PayoutRequestScreen from '../app/payout-request';
import { ApiError } from '../lib/api-client';

const ready = {
  success: true,
  availableTokenSubunits: 1_100_000,
  heldTokenSubunits: 0,
  lifetimeEarnedTokenSubunits: 1_100_000,
  lifetimePaidOutTokenSubunits: 0,
  availableUsd: '$110.00',
  minimumTokenSubunits: 1_000_000,
  minimumUsd: '$100.00',
  canRequest: true,
  pendingRequest: null,
  history: [],
};

const trees: renderer.ReactTestRenderer[] = [];

function renderScreen() {
  act(() => {
    trees.push(renderer.create(<PayoutRequestScreen />));
  });
  return trees.at(-1)!;
}

function ofType(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.findAll((node) => String(node.type) === type);
}

function requestButton(tree: renderer.ReactTestRenderer) {
  return ofType(tree, 'primary-button').find((node) => node.props.label === 'Request payout');
}

function detailsField(tree: renderer.ReactTestRenderer) {
  return ofType(tree, 'app-text-input')[0];
}

function type(tree: renderer.ReactTestRenderer, text: string) {
  act(() => { (detailsField(tree).props.onChangeText as (value: string) => void)(text); });
}

async function press(tree: renderer.ReactTestRenderer) {
  await act(async () => { (requestButton(tree)!.props.onPress as () => void)(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  routerState.canGoBack.mockReturnValue(true);
  authState.user = { id: 'creator-1' };
  payout.result = { data: ready, isError: false, isLoading: false, isFetching: false, refetch: vi.fn() };
  dialog.showConfirmDialog.mockResolvedValue(true);
  authState.api.requestCreatorPayout.mockResolvedValue(mobileApiContract.endpoints.requestCreatorPayout.response);
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
  vi.useRealTimers();
});

describe('Withdraw', () => {
  it('asks a signed-out person to sign in, and comes back here after', () => {
    authState.user = null;
    const tree = renderScreen();

    expect(ofType(tree, 'section-title')[0].props.title).toBe('Sign in to withdraw.');
    act(() => { (ofType(tree, 'primary-button')[0].props.onPress as () => void)(); });
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/payout-request' } });
  });

  it('offers no request below the floor or while one is on its way', () => {
    payout.result = { ...payout.result, data: { ...ready, canRequest: false, availableUsd: '$8.50' } };
    expect(ofType(renderScreen(), 'status-block')[0].props.title).toBe('Nothing to withdraw yet');

    payout.result = { ...payout.result, data: { ...ready, pendingRequest: { id: 'r1' } } };
    const pending = renderScreen();
    expect(ofType(pending, 'status-block')[0].props.title).toBe('A payout is already on its way');
    expect(requestButton(pending)).toBeUndefined();
  });

  it('lets a failed read be tried again, over a balance an earlier read left', () => {
    const refetch = vi.fn();
    payout.result = { data: ready, isError: true, isLoading: false, isFetching: false, refetch };
    const tree = renderScreen();

    expect(ofType(tree, 'status-block')[0].props.title).toBe('Your balance could not be loaded');
    expect(requestButton(tree)).toBeUndefined();
    act(() => { (ofType(tree, 'secondary-button').find((node) => node.props.label === 'Retry')!.props.onPress as () => void)(); });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing until the confirm dialog is answered yes', async () => {
    dialog.showConfirmDialog.mockResolvedValue(false);
    const tree = renderScreen();
    type(tree, ' creator@okbank ');

    await press(tree);

    expect(dialog.showConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Withdraw $110.00?' }));
    expect(authState.api.requestCreatorPayout).not.toHaveBeenCalled();
  });

  it('files the payout, refreshes the balance everywhere and goes back', async () => {
    const tree = renderScreen();
    type(tree, ' creator@okbank ');

    await press(tree);

    expect(authState.api.requestCreatorPayout).toHaveBeenCalledWith({ payoutMethod: 'upi', payoutDetails: 'creator@okbank' });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['creator-payouts'] });
    expect(announce.announceQueued).toHaveBeenCalledWith('Payout requested.');
    // Never the "already on its way" refusal: the screen says it went through.
    expect(ofType(tree, 'status-block')[0].props.title).toBe('Payout requested');
    expect(navigationState.prevent).toBe(false);
    expect(routerState.back).not.toHaveBeenCalled();

    act(() => { vi.runAllTimers(); });
    expect(routerState.back).toHaveBeenCalledTimes(1);

    // A pop the guard still caught on the request's own commit goes through.
    navigationState.onPrevent!({ data: { action: { type: 'POP' } } });
    expect(navigationState.dispatch).toHaveBeenCalledWith({ type: 'POP' });
  });

  it('goes to Recipe Sales after a request when it was opened by a link', async () => {
    routerState.canGoBack.mockReturnValue(false);
    const tree = renderScreen();
    type(tree, 'creator@okbank');

    await press(tree);
    act(() => { vi.runAllTimers(); });

    expect(routerState.replace).toHaveBeenCalledWith('/seller-dashboard');
  });

  it('opens one dialog and sends one request however often it is tapped', async () => {
    let answer: (value: boolean) => void = () => {};
    dialog.showConfirmDialog.mockReturnValue(new Promise<boolean>((resolve) => { answer = resolve; }));
    const tree = renderScreen();
    type(tree, 'creator@okbank');

    await press(tree);
    await press(tree);
    await act(async () => { answer(true); });

    expect(dialog.showConfirmDialog).toHaveBeenCalledTimes(1);
    expect(authState.api.requestCreatorPayout).toHaveBeenCalledTimes(1);
  });

  it('keeps the guard on while the request is in flight', async () => {
    let settle: () => void = () => {};
    authState.api.requestCreatorPayout.mockReturnValue(new Promise((resolve) => { settle = () => resolve({}); }));
    const tree = renderScreen();
    type(tree, 'creator@okbank');

    await press(tree);

    expect(navigationState.prevent).toBe(true);
    expect(ofType(tree, 'stack-screen')[0].props.options).toEqual({ gestureEnabled: false });
    navigationState.onPrevent!({ data: { action: { type: 'POP' } } });
    expect(navigationState.dispatch).not.toHaveBeenCalled();
    await act(async () => { settle(); });
  });

  it.each([
    ['a refusal', (() => {
      const refusal = mobileApiContract.endpoints.requestCreatorPayout.errors.alreadyPending;
      return new ApiError(refusal.response.error, refusal.status, refusal.response, undefined, refusal.response.code);
    })(), mobileApiContract.endpoints.requestCreatorPayout.errors.alreadyPending.response.error],
    ['no network', new TypeError('Network request failed'), 'Couldn’t request the payout. Check your connection, then try again.'],
    ['an ended session', new ApiError('Unauthorized', 401, {}, undefined, 'UNAUTHORIZED'), 'Your session ended. Sign in again, then request the payout.'],
  ])('says what went wrong after %s and reads the balance again', async (_case, failure, words) => {
    authState.api.requestCreatorPayout.mockRejectedValue(failure);
    const tree = renderScreen();
    type(tree, 'creator@okbank');

    await press(tree);

    expect(detailsField(tree).props.error).toBe(words);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['creator-payouts'] });
    expect(routerState.back).not.toHaveBeenCalled();
    expect(navigationState.prevent).toBe(false);
  });

  it('holds Request payout until the details are long enough', () => {
    const tree = renderScreen();
    type(tree, 'ab');
    expect(requestButton(tree)!.props.disabled).toBe(true);

    type(tree, 'abc');
    expect(requestButton(tree)!.props.disabled).toBe(false);
  });
});
