// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerPush = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());
const showActionSheet = vi.hoisted(() => vi.fn());

const authState = vi.hoisted(() => ({
  api: {},
  credits: 2000,
  updateCredits: vi.fn(),
  user: { id: 'user-1' } as { id: string } | null,
}));

const queryState = vi.hoisted(() => ({
  data: null as Record<string, unknown> | null,
}));

vi.mock('expo-router', () => ({
  router: { push: routerPush },
  useLocalSearchParams: () => ({ assetId: 'asset-1' }),
}));

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Pill: (props: MockProps) => React.createElement('pill', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/media-preview', () => ({
  MediaPreview: (props: MockProps) => React.createElement('media-preview', props),
}));

vi.mock('@/components/post-resource-bundle-content', () => ({
  PostResourceBundleContent: (props: MockProps) => React.createElement('bundle-content', props),
}));

vi.mock('@/components/skeleton', () => ({
  DetailSkeleton: (props: MockProps) => React.createElement('detail-skeleton', props),
}));

vi.mock('@/lib/action-sheet', () => ({ showActionSheet }));

vi.mock('@/lib/copy-to-clipboard', () => ({ copyToClipboard: vi.fn() }));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));

vi.mock('@/lib/pricing', () => ({ formatCreditAmount: (amount: number) => String(amount) }));

vi.mock('@/lib/unlock-cache', () => ({ refreshUnlockedBundleCaches: vi.fn() }));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate, isPending: false, error: null }),
  useQuery: () => ({ data: queryState.data, error: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import MarketplaceAssetScreen from '../app/marketplace/[assetId]';

function paidDetail(priceUsdCents = 900) {
  return {
    accessMode: 'paid',
    lockedPreview: null,
    post: { id: 'post-1', mediaItems: [], mediaKind: null, mediaUrl: null },
    postId: 'post-1',
    previewText: 'Preview',
    priceUsdCents,
    resourceKinds: ['prompt'],
    resources: null,
    seller: { name: 'fluffy' },
    summary: 'Summary',
    title: 'Moody Pack',
    viewerCanAccess: false,
  };
}

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(MarketplaceAssetScreen));
  });
  return tree;
}

beforeEach(() => {
  routerPush.mockClear();
  mutate.mockClear();
  showActionSheet.mockClear();
  authState.credits = 2000;
  authState.user = { id: 'user-1' };
  queryState.data = paidDetail();
});

describe('marketplace asset screen (HIG S18)', () => {
  it('confirms a paid unlock before spending, then spends only on the confirmed action', () => {
    const tree = renderScreen();
    const buy = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    if (!buy) throw new Error('No unlock button');
    expect(buy.props.label).toBe('Unlock for 900 credits');

    renderer.act(() => { (buy.props.onPress as () => void)(); });
    expect(mutate).not.toHaveBeenCalled();
    expect(showActionSheet).toHaveBeenCalledTimes(1);

    const request = showActionSheet.mock.calls[0]?.[0] as { message: string; actions: Array<{ label: string; onPress?: () => void }> };
    expect(request.message).toContain('900 credits ($9.00)');
    request.actions[0]?.onPress?.();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('offers the credits path instead of a doomed unlock when the balance is short', () => {
    authState.credits = 100;
    const tree = renderScreen();

    const buy = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    expect(buy?.props.disabled).toBe(true);

    const texts = tree.root.findAll((node) => String(node.type) === 'text');
    expect(texts.some((node) => String(node.props.children).includes('more credits'))).toBe(true);

    const getCredits = tree.root.findAll((node) => String(node.type) === 'secondary-button'
      && node.props.label === 'Get credits')[0];
    if (!getCredits) throw new Error('No Get credits button');
    renderer.act(() => { (getCredits.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/pricing');
  });

  it('keeps a free unlock one tap, with no confirmation sheet', () => {
    queryState.data = { ...paidDetail(0), accessMode: 'free' };
    const tree = renderScreen();

    const get = tree.root.findAll((node) => String(node.type) === 'primary-button')[0];
    if (!get) throw new Error('No free unlock button');
    expect(String(get.props.label)).toContain('Free');

    renderer.act(() => { (get.props.onPress as () => void)(); });
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
