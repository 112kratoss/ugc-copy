// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const NOW = Date.parse('2026-11-26T18:00:00.000Z');
const endpoints = mobileApiContract.endpoints;

const routerState = vi.hoisted(() => ({ push: vi.fn() }));
const signUp = vi.hoisted(() => ({ open: vi.fn() }));
const actionSheet = vi.hoisted(() => ({ show: vi.fn() }));
const haptics = vi.hoisted(() => ({ select: vi.fn() }));
const seen = vi.hoisted(() => ({ mark: vi.fn(async () => undefined) }));
const authState = vi.hoisted(() => ({
  api: {
    getSupportUpdates: vi.fn(),
    reactToSupportUpdate: vi.fn(),
    getSupportRoadmap: vi.fn(),
    reactToSupportRoadmapItem: vi.fn(),
  },
  user: { id: 'account-1' } as { id: string } | null,
}));
/**
 * The queries as the tabs read them. `setQueryData` runs its updater over the
 * data held here, as React Query's cache would, so the next render draws it.
 */
const cache = vi.hoisted(() => ({
  updates: {} as Record<string, unknown>,
  roadmap: {} as Record<string, unknown>,
  latest: [] as unknown[],
  infiniteOptions: [] as Array<{ queryKey: readonly unknown[] }>,
  queryOptions: [] as Array<{ queryKey: readonly unknown[] }>,
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (options: { queryKey: readonly unknown[] }) => {
    cache.infiniteOptions.push(options);
    return cache.updates;
  },
  useQuery: (options: { queryKey: readonly unknown[] }) => {
    cache.queryOptions.push(options);
    return cache.roadmap;
  },
  useQueryClient: () => ({
    setQueryData: (key: readonly unknown[], update: unknown) => {
      const apply = (current: unknown) => (typeof update === 'function' ? (update as (value: unknown) => unknown)(current) : update);
      if (key[0] === 'support-updates' && key[1] === 'list') cache.updates = { ...cache.updates, data: apply(cache.updates.data) };
      else if (key[0] === 'support-updates' && key[1] === 'latest') cache.latest.push(apply(undefined));
      else if (key[0] === 'support-roadmap') cache.roadmap = { ...cache.roadmap, data: apply(cache.roadmap.data) };
    },
  }),
}));
vi.mock('expo-router', () => ({ router: routerState }));
vi.mock('lucide-react-native', () => Object.fromEntries(
  ['ChevronRight', 'Hammer', 'Lightbulb', 'Megaphone', 'MessageCircle', 'MessageCircleOff', 'Rocket', 'SmilePlus', 'Sparkles', 'Telescope']
    .map((name) => [name, (props: MockProps) => React.createElement('icon', { ...props, name })]),
));
vi.mock('react-native', () => ({
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
    ItemSeparatorComponent,
    ...props
  }: MockProps & {
    data: unknown[];
    renderItem: (info: { item: unknown }) => React.ReactNode;
    keyExtractor: (item: unknown) => string;
    ItemSeparatorComponent?: React.ComponentType;
  }) => React.createElement(
    'flat-list',
    props,
    ListHeaderComponent as React.ReactNode,
    data.length === 0 ? ListEmptyComponent as React.ReactNode : data.map((item, index) => React.createElement(
      React.Fragment,
      { key: keyExtractor(item) },
      index > 0 && ItemSeparatorComponent ? React.createElement(ItemSeparatorComponent) : null,
      renderItem({ item }),
    )),
    ListFooterComponent as React.ReactNode,
  ),
  Pressable: ({ children, style, ...props }: MockProps & { style?: unknown }) => React.createElement(
    'pressable',
    { ...props, style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style },
    children,
  ),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));
vi.mock('@/components/skeleton', () => ({ SkeletonBone: (props: MockProps) => React.createElement('skeleton-bone', props) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/action-sheet', () => ({ showActionSheet: actionSheet.show }));
vi.mock('@/lib/haptics', () => ({ haptic: haptics }));
vi.mock('@/lib/join-navigation', () => ({ openSignUpSheet: signUp.open }));
vi.mock('@/lib/support-updates-seen', () => ({ markSupportUpdatesSeen: seen.mark }));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({ colors: new Proxy({}, { get: (_target, name) => `colour:${String(name)}` }) }),
}));

import { SupportRoadmapTab } from '../components/support-hub-roadmap';
import { SupportUpdatesTab } from '../components/support-hub-updates';
import { ApiError } from '../lib/api-client';
import { readSupportRoadmapResponse, readSupportUpdatesPage } from '../lib/support-hub-policy/support-hub-policy';

const contractPage = readSupportUpdatesPage(endpoints.getSupportUpdates.response)!;
const contractRoadmap = readSupportRoadmapResponse(endpoints.getSupportRoadmap.response)!;
const UPDATE_ID = contractPage.updates[0].id;

function updatesState(overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [contractPage], pageParams: [null] },
    dataUpdatedAt: NOW,
    isError: false,
    isPending: false,
    isRefetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(async () => undefined),
    fetchNextPage: vi.fn(async () => undefined),
    ...overrides,
  };
}

function roadmapState(overrides: Record<string, unknown> = {}) {
  return {
    data: contractRoadmap,
    dataUpdatedAt: Date.parse('2026-11-26T12:00:00.000Z'),
    isError: false,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mount(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

/** Every string drawn, nested text included. */
function drawnText(tree: renderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const visit = (node: renderer.ReactTestRendererJSON | string | null) => {
    if (node === null) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) visit(child as renderer.ReactTestRendererJSON | string);
  };
  const json = tree.toJSON();
  for (const node of Array.isArray(json) ? json : [json]) visit(node as renderer.ReactTestRendererJSON);
  return out;
}

function pressable(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label);
}

function pressables(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label);
}

/** A promise held open by the test, settled when it says. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: 'account-1' };
  for (const call of Object.values(authState.api)) call.mockReset();
  cache.updates = updatesState();
  cache.roadmap = roadmapState();
  cache.latest.length = 0;
  cache.infiniteOptions.length = 0;
  cache.queryOptions.length = 0;
});

describe("Help & Support's Updates", () => {
  const element = (active = true) => <SupportUpdatesTab active={active} />;

  it('reads the reader\'s own updates, twenty to a page, each page from the one before\'s cursor', async () => {
    mount(element());
    const options = cache.infiniteOptions.at(-1) as unknown as {
      queryKey: readonly unknown[];
      initialPageParam: unknown;
      queryFn: (context: { pageParam: string | null }) => Promise<unknown>;
      getNextPageParam: (page: { nextCursor: string | null }) => unknown;
    };
    expect(options.queryKey).toEqual(['support-updates', 'list', 'account-1']);
    expect(options.initialPageParam).toBeNull();
    authState.api.getSupportUpdates.mockResolvedValueOnce(contractPage);
    await options.queryFn({ pageParam: 'cursor-2' });
    expect(authState.api.getSupportUpdates).toHaveBeenCalledWith({ cursor: 'cursor-2' });
    expect(options.getNextPageParam({ nextCursor: 'cursor-3' })).toBe('cursor-3');
    expect(options.getNextPageParam({ nextCursor: null })).toBeUndefined();
  });

  it('draws each update as a card: its kind, date, title, first lines, reactions and comments', () => {
    const tree = mount(element());
    const drawn = drawnText(tree);

    expect(drawn).toEqual(expect.arrayContaining([
      'Announcement',
      'Today',
      'Folders are here',
      'Group your creations into folders from your profile. Tell us what you think in the comments.',
      '👍', '12', '❤️', '3',
      '4 comments',
    ]));
    const card = pressable(tree, 'Announcement, Folders are here, Today. Group your creations into folders from your profile. Tell us what you think in the comments.');
    expect(card.props.accessibilityRole).toBe('button');
    // The reader's own reaction is drawn selected.
    expect(pressable(tree, '👍, 12 people, yours').props.accessibilityState).toEqual({ selected: true });
    expect(pressable(tree, '❤️, 3 people').props.accessibilityState).toEqual({ selected: false });
  });

  it('opens an update on its post page, from the card and from its comments', () => {
    const tree = mount(element());
    act(() => { (pressable(tree, '4 comments').props.onPress as () => void)(); });
    act(() => {
      (tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityHint === 'Opens the update and its comments'
        && String(node.props.accessibilityLabel).startsWith('Announcement')).props.onPress as () => void)();
    });
    expect(routerState.push.mock.calls).toEqual([[`/post/${UPDATE_ID}`], [`/post/${UPDATE_ID}`]]);
  });

  it('says when an update\'s comments are off', () => {
    cache.updates = updatesState({
      data: { pages: [{ ...contractPage, updates: [{ ...contractPage.updates[0], commentCount: 0, commentsLocked: true }] }], pageParams: [null] },
    });
    const tree = mount(element());
    expect(drawnText(tree)).toContain('Comments are off');
    expect(pressable(tree, 'Comments are off').props.accessibilityRole).toBe('button');
  });

  it('marks the updates seen once the newest has been shown, and not while another tab is in front', () => {
    mount(element(false));
    expect(seen.mark).not.toHaveBeenCalled();

    mount(element(true));
    expect(seen.mark).toHaveBeenCalledWith('2026-11-26T12:00:00.000Z');
    // The dot's own read takes the fresher time.
    expect(cache.latest).toEqual(['2026-11-26T12:00:00.000Z']);
  });

  it('draws a reaction at once, sends it, and keeps the answer', async () => {
    const answer = deferred<{ reactions: Record<string, number>; myReaction: string | null }>();
    authState.api.reactToSupportUpdate.mockReturnValueOnce(answer.promise);
    const tree = mount(element());

    act(() => { (pressable(tree, '❤️, 3 people').props.onPress as () => void)(); });
    expect(haptics.select).toHaveBeenCalledTimes(1);
    expect(authState.api.reactToSupportUpdate).toHaveBeenCalledWith(UPDATE_ID, '❤️');
    act(() => tree.update(element()));
    // One person moves from 👍 to ❤️ while the request is on its way.
    expect(pressable(tree, '❤️, 4 people, yours')).toBeTruthy();
    expect(pressable(tree, '👍, 11 people')).toBeTruthy();

    await act(async () => { answer.resolve({ reactions: { '👍': 11, '❤️': 5 }, myReaction: '❤️' }); });
    act(() => tree.update(element()));
    expect(pressable(tree, '❤️, 5 people, yours')).toBeTruthy();
  });

  it('offers all six reactions from the React button, the reader\'s own selected', async () => {
    authState.api.reactToSupportUpdate.mockResolvedValueOnce({ reactions: { '👍': 11, '❤️': 3, '🙏': 1 }, myReaction: '🙏' });
    const tree = mount(element());

    act(() => { (pressable(tree, 'React').props.onPress as () => void)(); });
    const request = actionSheet.show.mock.calls[0][0] as {
      title: string;
      actions: unknown[];
      reactions: { label: string; options: string[]; selected: string | null; onSelect: (emoji: string) => void };
    };
    expect(request.title).toBe('Folders are here');
    expect(request.actions).toEqual([]);
    expect(request.reactions).toMatchObject({ label: 'React', options: ['👍', '❤️', '😂', '😮', '😢', '🙏'], selected: '👍' });

    await act(async () => { request.reactions.onSelect('🙏'); });
    expect(authState.api.reactToSupportUpdate).toHaveBeenCalledWith(UPDATE_ID, '🙏');
  });

  it('puts a refused reaction back and says it was not saved', async () => {
    authState.api.reactToSupportUpdate.mockRejectedValueOnce(new ApiError('Your reaction was not saved.', 500));
    const tree = mount(element());

    await act(async () => { (pressable(tree, '👍, 12 people, yours').props.onPress as () => void)(); });
    act(() => tree.update(element()));

    expect(authState.api.reactToSupportUpdate).toHaveBeenCalledWith(UPDATE_ID, null);
    expect(pressable(tree, '👍, 12 people, yours')).toBeTruthy();
    expect(drawnText(tree)).toContain('Your reaction was not saved. Try again.');
  });

  it('asks a guest to sign up to react, and comes back to Updates', () => {
    authState.user = null;
    const tree = mount(element());

    act(() => { (pressable(tree, '👍, 12 people, yours').props.onPress as () => void)(); });
    act(() => { (pressable(tree, 'Sign in to react').props.onPress as () => void)(); });

    expect(signUp.open.mock.calls).toEqual([[routerState, '/support?tab=updates'], [routerState, '/support?tab=updates']]);
    expect(authState.api.reactToSupportUpdate).not.toHaveBeenCalled();
    expect(actionSheet.show).not.toHaveBeenCalled();
    expect(pressable(tree, '👍, 12 people, yours').props.accessibilityHint).toBe('Sign in to react');
  });

  it('shows more on request, and refreshes on a pull', async () => {
    cache.updates = updatesState({ hasNextPage: true });
    const tree = mount(element());
    const more = tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === 'Show more');
    act(() => { (more.props.onPress as () => void)(); });
    expect((cache.updates.fetchNextPage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    const list = tree.root.findByType('flat-list' as never);
    expect(list.props.refreshing).toBe(false);
    await act(async () => { (list.props.onRefresh as () => void)(); });
    expect((cache.updates.refetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType('flat-list' as never).props.refreshing).toBe(false);
  });

  it('says when there is nothing yet, when it is loading, and when it could not load', () => {
    cache.updates = updatesState({ data: { pages: [{ updates: [], nextCursor: null, latestAt: null }], pageParams: [null] } });
    let tree = mount(element());
    expect(tree.root.findByType('status-block' as never).props).toMatchObject({
      title: 'No updates yet',
      body: 'News from the Magicbooklet team will show up here.',
    });
    act(() => tree.unmount());

    cache.updates = updatesState({ data: undefined, isPending: true });
    tree = mount(element());
    expect(tree.root.find((node) => node.props.accessibilityLabel === 'Loading updates').props.accessibilityRole).toBe('progressbar');
    act(() => tree.unmount());

    cache.updates = updatesState({ data: undefined, isPending: false, isError: true });
    tree = mount(element());
    expect(tree.root.findByType('status-block' as never).props).toMatchObject({
      tone: 'danger',
      title: 'Updates could not be loaded. Check your connection, then try again.',
    });
    act(() => { (tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === 'Try again').props.onPress as () => void)(); });
    expect((cache.updates.refetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

describe("Help & Support's Roadmap", () => {
  const onSuggestFeature = vi.fn();
  const element = () => <SupportRoadmapTab onSuggestFeature={onSuggestFeature} />;

  it('reads the reader\'s own roadmap', async () => {
    mount(element());
    const options = cache.queryOptions.at(-1) as unknown as { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };
    expect(options.queryKey).toEqual(['support-roadmap', 'account-1']);
    authState.api.getSupportRoadmap.mockResolvedValueOnce(contractRoadmap);
    await options.queryFn();
    expect(authState.api.getSupportRoadmap).toHaveBeenCalledTimes(1);
  });

  it('groups the items under Building and Shipped recently, each with its votes and reactions', () => {
    const tree = mount(element());
    const drawn = drawnText(tree);

    expect(drawn).toEqual(expect.arrayContaining([
      'What we’re working on. React to the ones you want most.',
      'Building',
      'Folders for creations',
      'Group what you make by project.',
      '58 people want this',
      'Shipped recently',
      'Text posts',
      '9 people want this',
      'Missing something? Tell us in the chat.',
    ]));
    expect(drawn.indexOf('Building')).toBeLessThan(drawn.indexOf('Folders for creations'));
    expect(drawn.indexOf('Folders for creations')).toBeLessThan(drawn.indexOf('Shipped recently'));
    // Group headings are announced as headers.
    const headings = tree.root.findAll((node) => String(node.type) === 'app-text' && node.props.heading === true);
    expect(headings.map((node) => node.props.children)).toEqual(['Building', 'Shipped recently']);
  });

  it('opens the update a shipped item names, and only there', () => {
    const tree = mount(element());
    const read = tree.root.findAll((node) => String(node.type) === 'secondary-button' && node.props.label === 'Read the update');
    expect(read).toHaveLength(1);
    act(() => { (read[0].props.onPress as () => void)(); });
    expect(routerState.push).toHaveBeenCalledWith(`/post/${contractRoadmap.items[1].shippedUpdateId}`);
  });

  it('goes to the chat from Suggest a feature', () => {
    const tree = mount(element());
    const suggest = tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === 'Suggest a feature');
    act(() => { (suggest.props.onPress as () => void)(); });
    expect(onSuggestFeature).toHaveBeenCalledTimes(1);
  });

  it('votes with a reaction, and asks a guest to sign up first', async () => {
    authState.api.reactToSupportRoadmapItem.mockResolvedValueOnce({ reactions: { '🙏': 41, '👍': 18 }, myReaction: '🙏' });
    let tree = mount(element());
    await act(async () => { (pressable(tree, '🙏, 40 people').props.onPress as () => void)(); });
    expect(authState.api.reactToSupportRoadmapItem).toHaveBeenCalledWith(contractRoadmap.items[0].id, '🙏');
    act(() => tree.update(element()));
    expect(drawnText(tree)).toContain('59 people want this');
    act(() => tree.unmount());

    authState.user = null;
    cache.roadmap = roadmapState();
    tree = mount(element());
    act(() => { (pressables(tree, 'Sign in to react')[0].props.onPress as () => void)(); });
    expect(signUp.open).toHaveBeenCalledWith(routerState, '/support?tab=roadmap');
  });

  it('says when the roadmap is empty, still offering the chat, and when it could not load', () => {
    cache.roadmap = roadmapState({ data: { items: [] } });
    let tree = mount(element());
    expect(tree.root.findByType('status-block' as never).props).toMatchObject({
      title: 'Nothing on the roadmap yet',
      body: 'Have an idea? Tell us in the chat.',
    });
    expect(tree.root.findAll((node) => String(node.type) === 'primary-button' && node.props.label === 'Suggest a feature')).toHaveLength(1);
    act(() => tree.unmount());

    cache.roadmap = roadmapState({ data: undefined, isPending: true });
    tree = mount(element());
    expect(tree.root.find((node) => node.props.accessibilityLabel === 'Loading the roadmap').props.accessibilityRole).toBe('progressbar');
    expect(tree.root.findAll((node) => String(node.type) === 'primary-button')).toHaveLength(0);
    act(() => tree.unmount());

    cache.roadmap = roadmapState({ data: undefined, isError: true });
    tree = mount(element());
    expect(tree.root.findByType('status-block' as never).props).toMatchObject({
      tone: 'danger',
      title: 'The roadmap could not be loaded. Check your connection, then try again.',
    });
  });
});
