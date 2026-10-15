// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerPostBundleSummary, OwnerPostListItem, OwnerPostsResponse } from '../lib/types';

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

type ListingsQueryOptions = {
  enabled: boolean;
  queryKey: unknown[];
  queryFn: (context: { pageParam: number }) => unknown;
  getNextPageParam: (lastPage: OwnerPostsResponse) => unknown;
};

// The same result object on every render, so a re-render cannot hide a call.
const listings = vi.hoisted(() => ({
  options: null as null | ListingsQueryOptions,
  result: {} as Record<string, unknown>,
}));

const payout = vi.hoisted(() => ({
  result: { data: undefined as unknown, isError: false, refetch: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (options: ListingsQueryOptions) => {
    listings.options = options;
    return listings.result;
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
vi.mock('@/components/resource-kind-row', () => ({
  ResourceKindRow: (props: MockProps) => React.createElement('resource-kind-row', props),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Pill: (props: MockProps) => React.createElement('pill', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
  WebLinkButton: (props: MockProps) => React.createElement('web-link-button', props),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://site.example' } }));
vi.mock('@/lib/home-view-model', () => ({
  formatUsdCents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
}));
vi.mock('@/lib/profile-view-model', () => ({ WALLET_UNAVAILABLE_CAPTION: 'Balance unavailable' }));
vi.mock('@/lib/use-creator-payout-state', () => ({ useCreatorPayoutState: () => payout.result }));
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

function listingsResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    isLoading: false,
    isLoadingError: false,
    isRefetchError: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function listing(
  id: string,
  { bundle, ...post }: Partial<Omit<OwnerPostListItem, 'bundle'>> & { bundle?: Partial<OwnerPostBundleSummary> } = {},
): OwnerPostListItem {
  return {
    id,
    title: `Recipe ${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    visibility: 'public',
    mediaUrl: null,
    mediaKind: null,
    commentCount: 0,
    archivedAt: null,
    tombstonedAt: null,
    ...post,
    bundle: {
      id: `bundle-${id}`,
      accessMode: 'paid',
      status: 'published',
      priceUsdCents: 900,
      salesCount: 0,
      earningsUsdCents: 0,
      resourceKinds: ['prompt'],
      reviewStatus: 'visible',
      quality: { eligible: true, message: null },
      retiredAt: null,
      ...bundle,
    },
  };
}

function signedInWith(posts: OwnerPostListItem[], overrides: Record<string, unknown> = {}) {
  authState.user = { id: 'seller-1', email: 'seller@example.com' };
  listings.result = listingsResult({
    data: { pages: [{ success: true, posts, summary: { earningsUsdCents: 2295, listingCount: posts.length, salesCount: 3 } }] },
    ...overrides,
  });
}

function textOf(node: renderer.ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

function ofType(node: renderer.ReactTestInstance, type: string) {
  return node.findAll((candidate) => String(candidate.type) === type);
}

function texts(node: renderer.ReactTestInstance) {
  return ofType(node, 'app-text').map(textOf);
}

function chips(node: renderer.ReactTestInstance) {
  return ofType(node, 'pill').map((pill) => pill.props.label as string);
}

function row(tree: renderer.ReactTestRenderer, title: string) {
  return tree.root.find((node) => String(node.type) === 'pressable'
    && String(node.props.accessibilityLabel).startsWith(`Edit listing ${title},`));
}

function button(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === label);
}

function buttonLabels(tree: renderer.ReactTestRenderer) {
  return ofType(tree.root, 'secondary-button').map((node) => node.props.label as string);
}

function statusTitles(tree: renderer.ReactTestRenderer) {
  return ofType(tree.root, 'status-block').map((node) => node.props.title as string);
}

function routerPush() {
  return routerState.push.mock.calls.map(([href]) => href);
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = null;
  listings.options = null;
  listings.result = listingsResult();
  payout.result = { data: undefined, isError: false, refetch: vi.fn() };
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

describe('Your Sales listings', () => {
  // It paged through every post on the account, 30 at a time with their media,
  // to find the ones with a recipe (audit 03-7).
  it('asks the server for listings only, with the totals on the first page', () => {
    signedInWith([]);
    renderScreen();

    void listings.options!.queryFn({ pageParam: 0 });
    void listings.options!.queryFn({ pageParam: 30 });

    expect(listings.options?.enabled).toBe(true);
    expect(listings.options?.queryKey).toEqual(['seller-dashboard-posts', 'seller-1']);
    expect(authState.api.listOwnerPosts.mock.calls).toEqual([
      [{ includeArchived: true, includeSummary: true, limit: 30, listingsOnly: true, offset: 0, visibility: 'all' }],
      [{ includeArchived: true, includeSummary: false, limit: 30, listingsOnly: true, offset: 30, visibility: 'all' }],
    ]);
    const page = (nextOffset: number | null): OwnerPostsResponse => ({
      success: true,
      posts: [],
      pageInfo: { hasMore: nextOffset !== null, limit: 30, nextOffset, offset: 0 },
    });
    expect(listings.options!.getNextPageParam(page(30))).toBe(30);
    expect(listings.options!.getNextPageParam(page(null))).toBeUndefined();
  });

  it('reads the totals from the first page', () => {
    signedInWith([listing('a')]);
    const tree = renderScreen();

    const metrics = ofType(tree.root, 'view').map((node) => node.props.accessibilityLabel).filter(Boolean);
    expect(metrics).toEqual(expect.arrayContaining(['Tracked earnings: $22.95', 'Sales: 3']));
  });

  // A listing taken down, flagged or failing the listing check read
  // "Published · Public" here, as if buyers could see it (audit 03-3).
  it('says why a listing is not selling, in the web sell page’s words', () => {
    signedInWith([
      listing('ready', { title: 'Ready recipe' }),
      listing('hidden', { title: 'Hidden recipe', bundle: { reviewStatus: 'hidden' } }),
      listing('flagged', { title: 'Flagged recipe', bundle: { reviewStatus: 'flagged' } }),
      listing('weak', {
        title: 'Weak recipe',
        bundle: { quality: { eligible: false, message: 'Add a useful preview or summary that tells buyers what the recipe includes.' } },
      }),
      listing('archived', {
        title: 'Archived recipe',
        archivedAt: '2026-10-02T00:00:00.000Z',
        bundle: { quality: { eligible: false, message: 'Publish a visible public post before listing this recipe in the marketplace.' } },
      }),
      listing('draft', {
        title: 'Draft recipe',
        visibility: 'private',
        bundle: { status: 'draft', quality: { eligible: false, message: 'Publish a visible public post before listing this recipe in the marketplace.' } },
      }),
    ]);
    const tree = renderScreen();

    expect(chips(row(tree, 'Ready recipe'))).toEqual([]);
    expect(texts(row(tree, 'Ready recipe'))).toContain('Published · Public');

    expect(chips(row(tree, 'Hidden recipe'))).toEqual(['Hidden in review']);
    expect(ofType(row(tree, 'Hidden recipe'), 'pill')[0].props.accent).toBe('danger');
    expect(chips(row(tree, 'Flagged recipe'))).toEqual(['Flagged for review']);
    expect(ofType(row(tree, 'Flagged recipe'), 'pill')[0].props.accent).toBe('amber');

    expect(chips(row(tree, 'Weak recipe'))).toEqual(['Needs work']);
    expect(texts(row(tree, 'Weak recipe'))).toContain('Add a useful preview or summary that tells buyers what the recipe includes.');

    // An archived post says so instead of its old settings.
    expect(chips(row(tree, 'Archived recipe'))).toEqual(['Needs work', 'Archived post']);
    expect(texts(row(tree, 'Archived recipe'))).not.toContain('Published · Public');
    expect(texts(row(tree, 'Archived recipe'))).toContain('Publish a visible public post before listing this recipe in the marketplace.');

    // A draft is a draft, not "Needs work", but still hears what to fix, as on the web.
    expect(chips(row(tree, 'Draft recipe'))).toEqual([]);
    expect(texts(row(tree, 'Draft recipe'))).toEqual(expect.arrayContaining([
      'Draft · Private',
      'Publish a visible public post before listing this recipe in the marketplace.',
    ]));

    // What the row draws is what it says to a screen reader.
    expect(row(tree, 'Hidden recipe').props.accessibilityLabel)
      .toBe('Edit listing Hidden recipe, 900 credits · 0 sales · $0.00 tracked earnings, Published · Public, Hidden in review');
  });

  // The app drew neither price nor kinds, and called a free open a sale (audit 03-3, 03-8).
  it('prices a recipe in credits, counts free opens apart from sales, and lists its kinds', () => {
    signedInWith([
      listing('paid', { title: 'Paid recipe', bundle: { salesCount: 3, earningsUsdCents: 2295, resourceKinds: ['prompt', 'notes'] } }),
      listing('one', { title: 'One sale', bundle: { priceUsdCents: 1200, salesCount: 1, earningsUsdCents: 1020 } }),
      listing('free', { title: 'Free recipe kit', bundle: { accessMode: 'free', priceUsdCents: 0, salesCount: 5 } }),
    ]);
    const tree = renderScreen();

    expect(texts(row(tree, 'Paid recipe'))).toContain('900 credits · 3 sales · $22.95 tracked earnings');
    expect(texts(row(tree, 'One sale'))).toContain('1,200 credits · 1 sale · $10.20 tracked earnings');
    expect(texts(row(tree, 'Free recipe kit'))).toContain('Free recipe · 5 opened');
    expect(ofType(row(tree, 'Paid recipe'), 'resource-kind-row')[0].props.kinds).toEqual(['prompt', 'notes']);
    // Never a cash price beside a recipe in the app (App Review, 0.1.6).
    expect(texts(tree.root).join(' ')).not.toMatch(/\$9\.00|\$12\.00/);
  });

  // A row opened the composer on Details; the recipe was a step away (audit 03-12).
  it('opens a listing on its recipe in the composer', () => {
    signedInWith([listing('ready', { title: 'Ready recipe' })]);
    const tree = renderScreen();

    act(() => { (row(tree, 'Ready recipe').props.onPress as () => void)(); });

    expect(routerPush()).toEqual([{ pathname: '/post/new', params: { postId: 'ready', focus: 'resources' } }]);
  });

  // It read "Archived post" and opened the composer on a post deleted with
  // buyers, whose edit the server now refuses (audit 03-4).
  it('labels a post deleted with buyers and does not open the composer on it', () => {
    signedInWith([
      listing('gone', {
        title: 'Deleted recipe',
        visibility: 'private',
        archivedAt: '2026-10-03T00:00:00.000Z',
        tombstonedAt: '2026-10-03T00:00:00.000Z',
        bundle: { reviewStatus: 'hidden', quality: { eligible: false, message: 'Publish a visible public post before listing this recipe in the marketplace.' } },
      }),
    ]);
    const tree = renderScreen();

    expect(ofType(tree.root, 'pressable')).toEqual([]);
    const deleted = tree.root.find((node) => String(node.type) === 'view'
      && String(node.props.accessibilityLabel).startsWith('Deleted recipe,'));
    expect(chips(deleted)).toEqual(['Deleted · buyers keep access']);
    expect(texts(deleted).join(' ')).not.toContain('Publish a visible public post');
    expect(deleted.props.accessibilityLabel).toContain('Deleted · buyers keep access');
    expect(routerPush()).toEqual([]);
  });

  it('offers more listings only while the server has more', () => {
    signedInWith([listing('a')]);
    const last = renderScreen();
    expect(buttonLabels(last)).not.toContain('Load more listings');

    signedInWith([listing('a')], { hasNextPage: true });
    const more = renderScreen();
    act(() => { (button(more, 'Load more listings').props.onPress as () => void)(); });

    expect(listings.result.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  // The paging effect asked for the next page again after every failure, a
  // request loop running under the error it had drawn (audit 03-7).
  it('stops at a failed page, keeps the listings, and asks again only on Retry', () => {
    authState.user = { id: 'seller-1', email: 'seller@example.com' };
    // As React Query reports it: 30 of 31 listings loaded, the next page failed.
    listings.result = listingsResult({
      data: {
        pages: [{
          success: true,
          posts: [listing('ready', { title: 'Ready recipe' })],
          summary: { earningsUsdCents: 2295, listingCount: 31, salesCount: 3 },
        }],
      },
      error: new Error('Network request failed.'),
      hasNextPage: true,
      isFetchNextPageError: true,
    });
    const tree = renderScreen();
    act(() => { tree.update(<SellerDashboardScreen />); });

    expect(listings.result.fetchNextPage).not.toHaveBeenCalled();
    expect(row(tree, 'Ready recipe')).toBeTruthy();
    expect(statusTitles(tree)).toEqual(['Could not load more listings']);
    expect(buttonLabels(tree)).not.toContain('Load more listings');

    act(() => { (button(tree, 'Retry').props.onPress as () => void)(); });
    expect(listings.result.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('says the dashboard could not load, and retries the listings and the balance', () => {
    authState.user = { id: 'seller-1', email: 'seller@example.com' };
    listings.result = listingsResult({ isLoadingError: true });
    const tree = renderScreen();

    expect(statusTitles(tree)).toEqual(['Could not load seller dashboard']);
    expect(ofType(tree.root, 'pressable')).toEqual([]);
    act(() => { (button(tree, 'Retry dashboard').props.onPress as () => void)(); });

    expect(listings.result.refetch).toHaveBeenCalledTimes(1);
    expect(payout.result.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the listings on screen when a refresh fails', () => {
    signedInWith([listing('ready', { title: 'Ready recipe' })], { isRefetchError: true });
    const tree = renderScreen();

    expect(statusTitles(tree)).toEqual(['Could not load seller dashboard']);
    expect(row(tree, 'Ready recipe')).toBeTruthy();
    expect(buttonLabels(tree)).not.toContain('Refresh dashboard');
  });

  it('refreshes the listings and the balance together', () => {
    signedInWith([listing('a')]);
    const tree = renderScreen();

    act(() => { (button(tree, 'Refresh dashboard').props.onPress as () => void)(); });

    expect(listings.result.refetch).toHaveBeenCalledTimes(1);
    expect(payout.result.refetch).toHaveBeenCalledTimes(1);
  });

  it('calls the account empty only when the server has no listing at all', () => {
    signedInWith([]);
    const empty = renderScreen();
    expect(statusTitles(empty)).toEqual(['No seller listings yet']);

    signedInWith([listing('a')]);
    expect(statusTitles(renderScreen())).toEqual([]);
  });
});

// The app had no payout surface at all; the only payout link was on the
// delete-account screen (audit 03-1, 03-2).
describe('Your Sales payout balance', () => {
  const state = {
    success: true,
    availableTokenSubunits: 1250,
    heldTokenSubunits: 0,
    lifetimeEarnedTokenSubunits: 4000,
    lifetimePaidOutTokenSubunits: 2750,
    availableUsd: '$12.50',
    minimumTokenSubunits: 10000,
    minimumUsd: '$100.00',
    canRequest: false,
    pendingRequest: null,
    history: [],
  };

  function payoutLink(tree: renderer.ReactTestRenderer) {
    return ofType(tree.root, 'web-link-button').map((node) => ({ href: node.props.href, label: node.props.label }));
  }

  it('shows what can be withdrawn and where payouts start, with the way to request one', () => {
    signedInWith([listing('a')]);
    payout.result = { data: state, isError: false, refetch: vi.fn() };
    const tree = renderScreen();

    expect(texts(tree.root)).toContain('Payout balance $12.50 · Payouts start at $100.00');
    expect(payoutLink(tree)).toEqual([{ href: 'https://site.example/marketplace/sell', label: 'Request a payout on the web' }]);
  });

  it('says the balance is unavailable when it cannot be read, over a figure an earlier read left', () => {
    signedInWith([listing('a')]);
    payout.result = { data: state, isError: true, refetch: vi.fn() };
    const tree = renderScreen();

    expect(texts(tree.root)).toContain('Balance unavailable');
    expect(texts(tree.root).join(' ')).not.toContain('$12.50');
    expect(payoutLink(tree)).toEqual([{ href: 'https://site.example/marketplace/sell', label: 'Request a payout on the web' }]);
  });

  it('draws the dash while the balance loads, and says so', () => {
    signedInWith([listing('a')]);
    const tree = renderScreen();

    const line = ofType(tree.root, 'app-text').find((node) => textOf(node) === 'Payout balance –');
    expect(line?.props.accessibilityLabel).toBe('Payout balance loading');
  });

  it('stays on screen when the listings could not load', () => {
    authState.user = { id: 'seller-1', email: 'seller@example.com' };
    listings.result = listingsResult({ isLoadingError: true });
    payout.result = { data: state, isError: false, refetch: vi.fn() };
    const tree = renderScreen();

    expect(texts(tree.root)).toContain('Payout balance $12.50 · Payouts start at $100.00');
  });
});
