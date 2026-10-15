// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api-client';
import { formatCreditHistoryTime } from '../lib/credit-history-view-model';
import type { CreditHistoryEntry, CreditHistoryResponse } from '../lib/types';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type FlatListProps = MockProps & {
  data: CreditHistoryEntry[];
  renderItem: (info: { item: CreditHistoryEntry; index: number }) => React.ReactNode;
  keyExtractor: (item: CreditHistoryEntry, index: number) => string;
  ListHeaderComponent?: React.ReactNode;
  ListEmptyComponent?: React.ReactNode;
  ListFooterComponent?: React.ReactNode;
};

const harness = vi.hoisted(() => ({
  // One object for every render, as the provider's value is.
  auth: {
    identityUserId: 'user-1' as string | null,
    credits: 1250 as number | null,
    api: { getCreditHistory: vi.fn() },
    refreshProfile: vi.fn(),
  },
  params: { current: {} as Record<string, string> },
  router: { push: vi.fn() },
  // The screen coming into view: on mount, and again when a test brings it back.
  focus: { callback: null as null | (() => void | (() => void)) },
  haptic: { light: vi.fn() },
}));

vi.mock('expo-router', () => ({
  router: harness.router,
  useLocalSearchParams: () => harness.params.current,
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    harness.focus.callback = callback;
    React.useEffect(() => {
      const cleanup = callback();
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    }, [callback]);
  },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('spinner', props),
  FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }: FlatListProps) => React.createElement(
    'flat-list',
    props,
    ListHeaderComponent ?? null,
    ...(data.length
      ? data.map((item, index) => React.createElement('list-cell', { key: keyExtractor(item, index), cellKey: keyExtractor(item, index) }, renderItem({ item, index })))
      : [ListEmptyComponent ?? null]),
    ListFooterComponent ?? null,
  ),
  RefreshControl: (props: MockProps) => React.createElement('refresh-control', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement('icon', { ...props, name });
  return {
    Gift: icon('Gift'),
    RotateCcw: icon('RotateCcw'),
    ShoppingBag: icon('ShoppingBag'),
    SlidersHorizontal: icon('SlidersHorizontal'),
    Sparkles: icon('Sparkles'),
    Undo2: icon('Undo2'),
  };
});

vi.mock('@/components/ui', () => {
  const box = (name: string) => ({ children, ...props }: MockProps) => React.createElement(name, props, children);
  return {
    AppText: box('text'),
    Card: box('card'),
    Kicker: box('kicker'),
    SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
    SectionTitle: (props: MockProps) => React.createElement('section-title', props),
    StatusBlock: (props: MockProps) => React.createElement('status-block', props),
  };
});

vi.mock('@/components/skeleton', () => ({
  CardListSkeleton: (props: MockProps) => React.createElement('card-list-skeleton', props),
}));

vi.mock('@/components/feed-pagination-footer', () => ({
  FeedEndFooter: (props: MockProps) => React.createElement('end-footer', props),
  FeedLoadMoreErrorFooter: (props: MockProps) => React.createElement('load-more-error', props),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => harness.auth }));
vi.mock('@/lib/haptics', () => ({ haptic: harness.haptic }));

import CreditHistoryScreen from '../app/credit-history';

const AT = '2026-10-15T12:00:00.000Z';

function entry(id: string, overrides: Partial<CreditHistoryEntry> = {}): CreditHistoryEntry {
  return {
    id,
    kind: 'spend',
    amount: -120,
    occurredAt: AT,
    title: 'Video generation',
    detail: 'Kling 3.0',
    ...overrides,
  };
}

function page(entries: Array<string | CreditHistoryEntry>, nextCursor: string | null = null): CreditHistoryResponse {
  return { entries: entries.map((item) => (typeof item === 'string' ? entry(item) : item)), nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let client: QueryClient;
const mounted: renderer.ReactTestRenderer[] = [];

async function flush() {
  // React Query hands its results over on a timer.
  for (let pass = 0; pass < 5; pass += 1) {
    await renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function screen() {
  return (
    <QueryClientProvider client={client}>
      <CreditHistoryScreen />
    </QueryClientProvider>
  );
}

async function mount() {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(screen());
  });
  mounted.push(tree);
  await flush();
  return tree;
}

const hosts = (tree: renderer.ReactTestRenderer, type: string) => tree.root.findAll((node) => String(node.type) === type);
const list = (tree: renderer.ReactTestRenderer) => hosts(tree, 'flat-list')[0];
const cellKeys = (tree: renderer.ReactTestRenderer) => hosts(tree, 'list-cell').map((cell) => cell.props.cellKey as string);
const statusTitles = (tree: renderer.ReactTestRenderer) => hosts(tree, 'status-block').map((node) => node.props.title as string);
const texts = (tree: renderer.ReactTestRenderer) => hosts(tree, 'text').map((node) => [node.props.children].flat().join(''));
/** Each row is the first view in its cell: the one a screen reader reads. */
const rows = (tree: renderer.ReactTestRenderer) => hosts(tree, 'list-cell').map((cell) => cell.findAll((node) => String(node.type) === 'view')[0]);
const askedCursors = () => harness.auth.api.getCreditHistory.mock.calls.map(([params]) => (params as { cursor: string | null }).cursor);

async function reachEnd(tree: renderer.ReactTestRenderer) {
  await renderer.act(async () => { (list(tree).props.onEndReached as () => void)(); });
  await flush();
}

async function comeBack() {
  await renderer.act(async () => { harness.focus.callback?.(); });
  await flush();
}

function button(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === label);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  harness.auth.identityUserId = 'user-1';
  harness.auth.credits = 1250;
  harness.auth.api.getCreditHistory.mockReset();
  harness.auth.refreshProfile.mockReset().mockResolvedValue(undefined);
  harness.params.current = {};
  harness.router.push.mockReset();
  harness.haptic.light.mockReset();
  harness.focus.callback = null;
});

afterEach(() => {
  for (const tree of mounted.splice(0)) renderer.act(() => tree.unmount());
  client.clear();
});

describe('the credit history list (D6, finding 03-11)', () => {
  it('lists the first page as the server words it, with which way each amount went and when', async () => {
    harness.auth.api.getCreditHistory.mockResolvedValueOnce(page([
      entry('purchase', { kind: 'purchase', amount: 2000, title: 'Creator pack', detail: null }),
      entry('welcome', { kind: 'grant', amount: 100, title: 'Welcome credits', detail: null }),
      entry('refund', { kind: 'refund', amount: 60, title: 'Refund: failed video', detail: 'Kling 3.0' }),
      entry('reversed', { kind: 'reversal', amount: -2000, title: 'Purchase refunded', detail: null }),
      entry('video'),
      entry('fixed', { kind: 'adjustment', amount: 25, title: 'Adjustment', detail: 'Goodwill' }),
    ]));
    const tree = await mount();

    expect(harness.auth.api.getCreditHistory).toHaveBeenCalledTimes(1);
    expect(harness.auth.api.getCreditHistory).toHaveBeenCalledWith({ cursor: null, limit: 30 });
    expect(cellKeys(tree)).toEqual(['purchase', 'welcome', 'refund', 'reversed', 'video', 'fixed']);
    expect(hosts(tree, 'icon').map((node) => node.props.name))
      .toEqual(['ShoppingBag', 'Gift', 'RotateCcw', 'Undo2', 'Sparkles', 'SlidersHorizontal']);
    expect(texts(tree)).toEqual(expect.arrayContaining(['Creator pack', '+2,000', '−2,000', 'Refund: failed video', 'Goodwill']));

    const amount = (shown: string) => hosts(tree, 'text').find((node) => node.props.children === shown);
    expect(amount('+2,000')?.props.color).toBe('success');
    expect(amount('−120')?.props.color).toBe('text');

    // Read as one sentence each, not as five separate fragments.
    const time = formatCreditHistoryTime(AT);
    expect(rows(tree)[4].props.accessible).toBe(true);
    expect(rows(tree)[4].props.accessibilityLabel).toBe(`Video generation, Kling 3.0, minus 120 credits, ${time}`);
    expect(texts(tree)).toContain(time);
    // Nothing opens from a row.
    expect(hosts(tree, 'pressable')).toHaveLength(0);

    expect(hosts(tree, 'end-footer').map((node) => node.props.message)).toEqual(['Your credit history starts here.']);
  });

  it("reads a guest's history by its identity, as it reads an account's", async () => {
    harness.auth.identityUserId = 'guest-1';
    harness.auth.api.getCreditHistory.mockResolvedValueOnce(page([entry('guest-pack', { kind: 'purchase', amount: 500, title: 'Starter pack' })]));
    const tree = await mount();

    expect(cellKeys(tree)).toEqual(['guest-pack']);
    expect(client.getQueryData(['credit-history', 'guest-1'])).toBeDefined();
    expect(statusTitles(tree)).toEqual([]);
  });

  it('waits for the session to start before asking, then asks by itself', async () => {
    harness.auth.identityUserId = null;
    const tree = await mount();

    expect(harness.auth.api.getCreditHistory).not.toHaveBeenCalled();
    expect(statusTitles(tree)).toEqual(['Your session is still starting']);
    expect(list(tree).props.refreshControl).toBeUndefined();

    harness.auth.identityUserId = 'guest-1';
    harness.auth.api.getCreditHistory.mockResolvedValueOnce(page(['first']));
    await renderer.act(async () => { tree.update(screen()); });
    await flush();

    expect(harness.auth.api.getCreditHistory).toHaveBeenCalledTimes(1);
    expect(cellKeys(tree)).toEqual(['first']);
    expect(list(tree).props.refreshControl).toBeDefined();
  });

  it('shows the skeleton while the first page is on its way', async () => {
    const answer = deferred<CreditHistoryResponse>();
    harness.auth.api.getCreditHistory.mockReturnValueOnce(answer.promise);
    const tree = await mount();

    expect(hosts(tree, 'card-list-skeleton').map((node) => node.props.label)).toEqual(['Loading credit history']);

    await renderer.act(async () => { answer.resolve(page(['first'])); });
    await flush();
    expect(hosts(tree, 'card-list-skeleton')).toHaveLength(0);
    expect(cellKeys(tree)).toEqual(['first']);
  });

  it('says when there is nothing to list yet, with no end marker', async () => {
    harness.auth.api.getCreditHistory.mockResolvedValueOnce(page([]));
    const tree = await mount();

    expect(statusTitles(tree)).toEqual(['No credit activity yet']);
    expect(hosts(tree, 'end-footer')).toHaveLength(0);
  });

  it('says the first page failed, and reads it again on Try again', async () => {
    harness.auth.api.getCreditHistory
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(page(['first']));
    const tree = await mount();

    expect(statusTitles(tree)).toEqual(['Could not load your credit history']);
    await renderer.act(async () => { (button(tree, 'Try again').props.onPress as () => void)(); });
    await flush();

    expect(askedCursors()).toEqual([null, null]);
    expect(statusTitles(tree)).toEqual([]);
    expect(cellKeys(tree)).toEqual(['first']);
  });
});

describe('loading older entries', () => {
  it('asks for the older page at the end of the list with the cursor it was given, and no more after the last', async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a', 'b'], 'cursor-2'))
      .mockResolvedValueOnce(page(['c']));
    const tree = await mount();
    expect(hosts(tree, 'end-footer')).toHaveLength(0);

    await reachEnd(tree);

    expect(harness.auth.api.getCreditHistory).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 30 });
    expect(cellKeys(tree)).toEqual(['a', 'b', 'c']);
    expect(hosts(tree, 'end-footer')).toHaveLength(1);

    await reachEnd(tree);
    expect(harness.auth.api.getCreditHistory).toHaveBeenCalledTimes(2);
  });

  it('shows a spinner below the rows while the older page loads', async () => {
    const older = deferred<CreditHistoryResponse>();
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockReturnValueOnce(older.promise);
    const tree = await mount();

    await reachEnd(tree);
    expect(hosts(tree, 'spinner').map((node) => node.props.accessibilityLabel)).toEqual(['Loading older credit history']);

    await renderer.act(async () => { older.resolve(page(['b'])); });
    await flush();
    expect(hosts(tree, 'spinner')).toHaveLength(0);
    expect(cellKeys(tree)).toEqual(['a', 'b']);
  });

  it('waits for Retry after an older page fails, rather than failing again at the end of the list', async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(page(['b']));
    const tree = await mount();

    await reachEnd(tree);
    expect(hosts(tree, 'load-more-error')).toHaveLength(1);
    expect(cellKeys(tree)).toEqual(['a']);
    await reachEnd(tree);
    expect(harness.auth.api.getCreditHistory).toHaveBeenCalledTimes(2);

    await renderer.act(async () => { (hosts(tree, 'load-more-error')[0].props.onRetry as () => void)(); });
    await flush();

    expect(askedCursors()).toEqual([null, 'cursor-2', 'cursor-2']);
    expect(cellKeys(tree)).toEqual(['a', 'b']);
    expect(hosts(tree, 'load-more-error')).toHaveLength(0);
  });

  it('starts over from the newest page when the server refuses the cursor, rather than asking with it again', async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockRejectedValueOnce(new ApiError('Invalid credit history cursor.', 400))
      .mockResolvedValueOnce(page(['new', 'a'], 'cursor-3'));
    const tree = await mount();

    await reachEnd(tree);
    expect(hosts(tree, 'load-more-error')).toHaveLength(0);
    expect(statusTitles(tree)).toEqual(['Your credit history changed since it was opened']);
    expect(cellKeys(tree)).toEqual(['a']);

    await renderer.act(async () => { (button(tree, 'Reload from the newest').props.onPress as () => void)(); });
    await flush();

    expect(askedCursors()).toEqual([null, 'cursor-2', null]);
    expect(cellKeys(tree)).toEqual(['new', 'a']);
    expect(statusTitles(tree)).toEqual([]);
    expect(button(tree, 'Load more').props.disabled).toBe(false);
  });

  it('keeps a Load more for a reader the list did not ask for, held while the newest page is read again', async () => {
    const fresh = deferred<CreditHistoryResponse>();
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockReturnValueOnce(fresh.promise)
      .mockResolvedValueOnce(page(['b']));
    const tree = await mount();
    expect(button(tree, 'Load more').props.disabled).toBe(false);

    // Back on the screen: the newest page is read again, and Load more waits for it.
    await comeBack();
    expect(button(tree, 'Load more').props.disabled).toBe(true);
    await renderer.act(async () => { fresh.resolve(page(['a'], 'cursor-2')); });
    await flush();

    await renderer.act(async () => { (button(tree, 'Load more').props.onPress as () => void)(); });
    await flush();

    expect(askedCursors()).toEqual([null, null, 'cursor-2']);
    expect(cellKeys(tree)).toEqual(['a', 'b']);
    expect(hosts(tree, 'secondary-button').map((node) => node.props.label)).not.toContain('Load more');
  });

  it("rounds the group's corners on its first and last rows only, and moves the bottom corners down as a page lands", async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a', 'b'], 'cursor-2'))
      .mockResolvedValueOnce(page(['c']));
    const tree = await mount();
    const corners = () => rows(tree).map((row) => {
      const style = row.props.style as Record<string, number>;
      return [style.borderTopLeftRadius > 0, style.borderBottomLeftRadius > 0];
    });

    expect(corners()).toEqual([[true, false], [false, true]]);
    await reachEnd(tree);
    expect(corners()).toEqual([[true, false], [false, false], [false, true]]);
  });
});

describe('reading the history again', () => {
  it('pulls only the newest page, lets the older ones go, and reads the balance again with it', async () => {
    const fresh = deferred<CreditHistoryResponse>();
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockResolvedValueOnce(page(['b']))
      .mockReturnValueOnce(fresh.promise);
    const tree = await mount();
    await reachEnd(tree);
    expect(cellKeys(tree)).toEqual(['a', 'b']);

    await renderer.act(async () => { (list(tree).props.refreshControl.props.onRefresh as () => void)(); });
    expect(list(tree).props.refreshControl.props.refreshing).toBe(true);
    expect(harness.haptic.light).toHaveBeenCalledTimes(1);
    expect(harness.auth.refreshProfile).toHaveBeenCalledTimes(1);

    await renderer.act(async () => { fresh.resolve(page(['new', 'a'], 'cursor-3')); });
    await flush();

    expect(askedCursors()).toEqual([null, 'cursor-2', null]);
    expect(cellKeys(tree)).toEqual(['new', 'a']);
    expect(list(tree).props.refreshControl.props.refreshing).toBe(false);
  });

  it('reads the newest page again when the screen comes back into view, never an older page with an old cursor', async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockResolvedValueOnce(page(['b']))
      // A purchase made on Pricing meanwhile.
      .mockResolvedValueOnce(page(['pack', 'a'], 'cursor-3'));
    const tree = await mount();
    await reachEnd(tree);

    await comeBack();

    expect(askedCursors()).toEqual([null, 'cursor-2', null]);
    expect(cellKeys(tree)).toEqual(['pack', 'a']);
    // The pull's spinner is the reader's own; an arrival never shows it.
    expect(list(tree).props.refreshControl.props.refreshing).toBe(false);
    expect(harness.auth.refreshProfile).not.toHaveBeenCalled();
  });

  it('lets an older page on its way finish when the screen comes back into view', async () => {
    const older = deferred<CreditHistoryResponse>();
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockReturnValueOnce(older.promise);
    const tree = await mount();
    await reachEnd(tree);

    await comeBack();
    await renderer.act(async () => { older.resolve(page(['b'])); });
    await flush();

    expect(askedCursors()).toEqual([null, 'cursor-2']);
    expect(cellKeys(tree)).toEqual(['a', 'b']);
  });

  it('shows what it had when opened again, then the newest page', async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockResolvedValueOnce(page(['b']));
    const first = await mount();
    await reachEnd(first);
    renderer.act(() => first.unmount());
    mounted.splice(0);

    const fresh = deferred<CreditHistoryResponse>();
    harness.auth.api.getCreditHistory.mockReturnValueOnce(fresh.promise);
    const again = await mount();
    // Drawn at once from the copy kept, cut back to its newest page.
    expect(cellKeys(again)).toEqual(['a']);
    expect(hosts(again, 'card-list-skeleton')).toHaveLength(0);

    await renderer.act(async () => { fresh.resolve(page(['video', 'a'], 'cursor-3')); });
    await flush();

    expect(askedCursors()).toEqual([null, 'cursor-2', null]);
    expect(cellKeys(again)).toEqual(['video', 'a']);
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('still lists and pages after every effect runs again', async () => {
    const inActivity = (mode: 'visible' | 'hidden') => (
      <QueryClientProvider client={client}>
        <React.Activity mode={mode}><CreditHistoryScreen /></React.Activity>
      </QueryClientProvider>
    );
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockResolvedValueOnce(page(['b']));
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(inActivity('visible')); });
    mounted.push(tree);
    await flush();

    await renderer.act(async () => { tree.update(inActivity('hidden')); });
    await renderer.act(async () => { tree.update(inActivity('visible')); });
    await flush();
    // The arrival effect did run again: the newest page was read a second time.
    expect(askedCursors()).toEqual([null, null]);

    await reachEnd(tree);
    expect(askedCursors()).toEqual([null, null, 'cursor-2']);
    expect(cellKeys(tree)).toEqual(['a', 'b']);
  });

  it('leaves the rows alone when the app comes back to the front or back online', async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a'], 'cursor-2'))
      .mockResolvedValueOnce(page(['b']));
    const tree = await mount();
    await reachEnd(tree);

    await renderer.act(async () => {
      client.getQueryCache().onFocus();
      client.getQueryCache().onOnline();
    });
    await flush();

    expect(harness.auth.api.getCreditHistory).toHaveBeenCalledTimes(2);
    expect(cellKeys(tree)).toEqual(['a', 'b']);
  });

  it('keeps the rows it has when the newest page cannot be read again, and says so', async () => {
    harness.auth.api.getCreditHistory
      .mockResolvedValueOnce(page(['a']))
      .mockRejectedValueOnce(new Error('Network request failed'));
    const tree = await mount();

    await comeBack();

    expect(cellKeys(tree)).toEqual(['a']);
    expect(statusTitles(tree)).toEqual(['Could not refresh your credit history']);
  });
});

describe('the balance above the list', () => {
  it('shows the balance and offers the credit packs', async () => {
    harness.auth.api.getCreditHistory.mockResolvedValueOnce(page(['a']));
    const tree = await mount();

    expect(texts(tree)).toContain('1,250 credits');
    await renderer.act(async () => { (button(tree, 'Get credits').props.onPress as () => void)(); });
    expect(harness.router.push).toHaveBeenCalledWith('/pricing');
  });

  it('leaves the packs to the Back button when opened from Pricing', async () => {
    harness.params.current = { source: 'pricing' };
    harness.auth.api.getCreditHistory.mockResolvedValueOnce(page(['a']));
    const tree = await mount();

    expect(texts(tree)).toContain('1,250 credits');
    expect(hosts(tree, 'secondary-button').map((node) => node.props.label)).not.toContain('Get credits');
  });

  it('says the balance is loading rather than drawing 0', async () => {
    harness.auth.credits = null;
    harness.auth.api.getCreditHistory.mockResolvedValueOnce(page(['a']));
    const tree = await mount();

    expect(texts(tree)).toContain('Balance loading…');
    expect(texts(tree)).not.toContain('0 credits');
  });
});
