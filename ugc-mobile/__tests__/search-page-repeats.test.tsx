import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExploreSearchOverlay } from '../components/explore-search-overlay';
import type { MagicbookletApiClient } from '../lib/api-client';
import {
  appendSearchPosts,
  isSearchPageAllRepeats,
} from '../lib/public-search-policy/search-blend';
import type { PublicSearchResponse, ShowcaseFeedItem } from '../lib/types';

// A later page of posts may hold a post an earlier page showed (the server
// repeats a post rather than skip one: contracts/mobile-api-v1.json,
// searchPublicContent.laterPages). The search screen leaves those out by id,
// and a page made of nothing else is not the end of the list: the end is the
// cursor being null. The web's half is
// src/__tests__/search-page-repeats-client.test.tsx. The mocks are those of
// explore-search-overlay.test.tsx.

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const mocks = vi.hoisted(() => {
  // Models React Native's BackHandler: listeners are consulted newest-first
  // and the first to return true ends the press.
  const listeners: Array<() => boolean> = [];
  return {
    listeners,
    reducedMotion: { value: true },
    forgetSearchQuery: vi.fn(async (_query: string) => [] as string[]),
    focused: { value: true },
    inputFocus: vi.fn(),
    keyboardDismiss: vi.fn(),
    addEventListener: vi.fn((_event: string, listener: () => boolean) => {
      listeners.push(listener);
      return {
        remove: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    }),
    // One router object for the whole file, so every render pushes through the same spy.
    router: { push: vi.fn() },
    // The registered account, null for a visitor and for a guest session.
    user: { value: null as { id: string } | null },
    announce: vi.fn(),
    // The results' scroll view, asked to move.
    scrollTo: vi.fn(),
    readSearchHistory: vi.fn(async () => [] as string[]),
    rememberSearchQuery: vi.fn(async (_query: string) => [] as string[]),
    // The phone's text size, as React Native reports it.
    fontScale: { value: 1 },
  };
});

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => mocks.focused.value,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: mocks.user.value }),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  BackHandler: { addEventListener: mocks.addEventListener },
  Keyboard: { dismiss: mocks.keyboardDismiss },
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  ScrollView: React.forwardRef(({ children, ...props }: MockProps, ref: React.ForwardedRef<{ scrollTo: (to: unknown) => void }>) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: mocks.scrollTo }));
    return React.createElement('scroll-view', props, children);
  }),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: React.forwardRef((props: MockProps, ref: React.ForwardedRef<{ focus: () => void }>) => {
    React.useImperativeHandle(ref, () => ({ focus: mocks.inputFocus }));
    return React.createElement('text-input', props);
  }),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: mocks.fontScale.value }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-router', () => ({
  router: mocks.router,
}));

vi.mock('lucide-react-native', () => ({
  BookOpen: (props: MockProps) => React.createElement('icon', props),
  Box: (props: MockProps) => React.createElement('icon', props),
  Wrench: (props: MockProps) => React.createElement('icon', props),
  Clock3: (props: MockProps) => React.createElement('icon', props),
  MessageCircle: (props: MockProps) => React.createElement('icon', props),
  Search: (props: MockProps) => React.createElement('icon', props),
  X: (props: MockProps) => React.createElement('icon', props),
  Play: (props: MockProps) => React.createElement('icon', props),
  ImageIcon: (props: MockProps) => React.createElement('icon', props),
}));

// A post's picture, as the feed's pins draw it: what it is given is what the test reads.
vi.mock('@/components/showcase-media-preview', () => ({
  ShowcaseMediaPreview: (props: MockProps) => React.createElement('showcase-media-preview', props),
}));

vi.mock('@/components/keyboard-aware', () => ({
  KeyboardAvoidingArea: ({ children, ...props }: MockProps) =>
    React.createElement('keyboard-avoiding-area', props, children),
}));

vi.mock('@/components/ui', () => ({
  ChoiceChip: (props: MockProps) => React.createElement('choice-chip', props),
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SegmentedControl: (props: MockProps) => React.createElement('segmented-control', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: {} }),
  // Reduce Motion on unless a test of the entrance turns it off: the field is
  // where it rests, taps are taken at once and Close pops at once.
  useReducedMotion: () => mocks.reducedMotion.value,
}));

vi.mock('@/lib/platform-glyphs', () => ({
  BackGlyph: (props: MockProps) => React.createElement('icon', props),
}));

vi.mock('@/lib/search-history', async (importOriginal) => ({
  // The real normalisers: the length gates count what they return.
  ...(await importOriginal<typeof import('../lib/search-history')>()),
  readSearchHistory: mocks.readSearchHistory,
  rememberSearchQuery: mocks.rememberSearchQuery,
  forgetSearchQuery: mocks.forgetSearchQuery,
  clearSearchHistory: async () => {},
}));

const searchPublicContent = vi.fn<MagicbookletApiClient['searchPublicContent']>();
// The typeahead's request. Nothing is asked until the field has the focus,
// which only the typeahead's own cases give it.
const suggestSearch = vi.fn<MagicbookletApiClient['suggestSearch']>();
// The starter (ideas before anything is typed): nothing, unless a case gives some.
const searchStarter = vi.fn<MagicbookletApiClient['searchStarter']>(async () => ({ entities: [], creators: [], searches: [] }));
const api = { searchPublicContent, suggestSearch, searchStarter } as unknown as MagicbookletApiClient;

type Tree = renderer.ReactTestRenderer;

async function render() {
  let tree: Tree | null = null;
  await act(async () => {
    tree = renderer.create(React.createElement(ExploreSearchOverlay, { api, visible: true, onClose: vi.fn() }));
  });
  return tree!;
}

function hostNodes(tree: Tree, type: string) {
  return tree.root.findAll((node) => node.type === type);
}

/** The posts on show, by id, each as often as it is drawn. Sorted: the masonry draws them column by column. */
function drawn(tree: Tree) {
  return hostNodes(tree, 'pressable')
    .map((node) => /^Open post Post (\S+) by /.exec(String(node.props.accessibilityLabel ?? ''))?.[1])
    .filter((id): id is string => Boolean(id))
    .sort();
}

function showMore(tree: Tree) {
  return hostNodes(tree, 'secondary-button').find((node) => node.props.label === 'Show more') ?? null;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function post(id: string): ShowcaseFeedItem {
  // Only what a result card reads.
  return {
    id, title: `Post ${id}`, creator: { name: 'Ana' }, mediaItems: [], mediaKind: 'image', mediaUrl: null,
    saveCount: 0, commentCount: 0,
  } as unknown as ShowcaseFeedItem;
}

function page(ids: string[], nextCursor: string | null): PublicSearchResponse {
  return {
    query: 'ocean at dusk',
    normalizedQuery: 'ocean at dusk',
    type: 'posts',
    sort: 'top',
    creators: { items: [], nextCursor: null },
    posts: { items: ids.map(post), nextCursor },
    recipes: { items: [], nextCursor: null },
  };
}

/** The cursors the screen asked for, in order; null is the first page. */
const cursors = () => searchPublicContent.mock.calls.map(([params]) => params.cursor ?? null);

async function openFirstPage(first: PublicSearchResponse) {
  searchPublicContent.mockResolvedValueOnce(first);
  const tree = await render();
  const posts = hostNodes(tree, 'pressable').find((node) => (
    node.props.accessibilityRole === 'tab' && node.findAll((child) => child.type === 'text').some((text) => text.children.join('') === 'Posts')
  ));
  await act(async () => { posts!.props.onPress(); });
  const input = hostNodes(tree, 'text-input')[0];
  await act(async () => { input.props.onChangeText('ocean at dusk'); });
  await act(async () => { input.props.onSubmitEditing(); });
  await advance(300);
  expect(cursors()).toEqual([null]);
  return tree;
}

describe('a later page of posts on the search screen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.length = 0;
    mocks.focused.value = true;
    mocks.user.value = null;
    mocks.fontScale.value = 1;
    searchPublicContent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws once a post the second page holds again', async () => {
    const tree = await openFirstPage(page(['p1', 'p2', 'p3'], 'cursor-2'));
    expect(drawn(tree)).toEqual(['p1', 'p2', 'p3']);

    searchPublicContent.mockResolvedValueOnce(page(['p3', 'p4', 'p1', 'p5'], null));
    await act(async () => { showMore(tree)!.props.onPress(); });
    await advance(50);

    expect(cursors()).toEqual([null, 'cursor-2']);
    expect(drawn(tree)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(showMore(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('asks for the page after one made only of posts already shown, once, and draws what that brings', async () => {
    const tree = await openFirstPage(page(['p1', 'p2', 'p3'], 'cursor-2'));

    searchPublicContent
      .mockResolvedValueOnce(page(['p2', 'p1'], 'cursor-3'))
      .mockResolvedValueOnce(page(['p4', 'p2'], null));
    await act(async () => { showMore(tree)!.props.onPress(); });
    await advance(50);

    // One press: the page of repeats, then the page after it.
    expect(cursors()).toEqual([null, 'cursor-2', 'cursor-3']);
    expect(drawn(tree)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(showMore(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('does not go on asking when the page after it is repeats as well: the list is not over, and the next press asks', async () => {
    const tree = await openFirstPage(page(['p1', 'p2', 'p3'], 'cursor-2'));

    searchPublicContent
      .mockResolvedValueOnce(page(['p1'], 'cursor-3'))
      .mockResolvedValueOnce(page(['p2'], 'cursor-4'))
      .mockResolvedValue(page(['p9'], null));
    await act(async () => { showMore(tree)!.props.onPress(); });
    await advance(500);

    // Two requests for the press, and no more: no loop.
    expect(cursors()).toEqual([null, 'cursor-2', 'cursor-3']);
    expect(drawn(tree)).toEqual(['p1', 'p2', 'p3']);
    // The list has not ended: its cursor is not null.
    expect(showMore(tree)).not.toBeNull();

    await act(async () => { showMore(tree)!.props.onPress(); });
    await advance(50);
    expect(cursors().at(-1)).toBe('cursor-4');
    expect(drawn(tree)).toEqual(['p1', 'p2', 'p3', 'p9']);
    expect(showMore(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('ends the list on a page of repeats with no cursor', async () => {
    const tree = await openFirstPage(page(['p1', 'p2'], 'cursor-2'));
    searchPublicContent.mockResolvedValueOnce(page(['p2', 'p1'], null));
    await act(async () => { showMore(tree)!.props.onPress(); });
    await advance(50);
    expect(cursors()).toEqual([null, 'cursor-2']);
    expect(drawn(tree)).toEqual(['p1', 'p2']);
    expect(showMore(tree)).toBeNull();
    await act(async () => tree.unmount());
  });

  it('follows the same rule as the web', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    expect(appendSearchPosts([a, b], [b, c, a, c])).toEqual([a, b, c]);
    expect(isSearchPageAllRepeats([a, b], { items: [b, a], nextCursor: 'more' })).toBe(true);
    expect(isSearchPageAllRepeats([a, b], { items: [b, c], nextCursor: 'more' })).toBe(false);
    expect(isSearchPageAllRepeats([a, b], { items: [b, a], nextCursor: null })).toBe(false);
    expect(isSearchPageAllRepeats([a, b], { items: [], nextCursor: 'more' })).toBe(false);
  });
});
