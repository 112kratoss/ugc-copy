// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const { authUser, mediaSource, platform, query, routerDismissTo, routerPush } = vi.hoisted(() => ({
  authUser: { current: { id: 'user-1' } as { id: string } | null },
  // Stands in for the hook that makes a link absolute and adds the bearer.
  mediaSource: (url: string) => ({
    source: { uri: `https://api.test${url}`, headers: { Authorization: 'Bearer token-1' } },
    requestKey: 'user-1:1',
  }),
  platform: { OS: 'ios' },
  // One object for every render; each test sets what the query returns.
  query: { current: {} as Record<string, unknown> },
  routerDismissTo: vi.fn(),
  routerPush: vi.fn(),
}));
const useMediaSource = vi.hoisted(() => vi.fn(mediaSource));
// What the website preference allows, as the hook reports it; each test sets it.
const reveal = vi.hoisted(() => ({ current: 'show' as 'show' | 'website' | 'pending' | 'never' }));
const useMatureReveal = vi.hoisted(() => vi.fn((_needed: boolean) => reveal.current));

vi.mock('expo-router', () => ({
  router: { push: routerPush, replace: vi.fn(), dismissTo: routerDismissTo, canGoBack: () => true },
}));

vi.mock('react-native', () => ({
  Platform: platform,
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  EyeOff: (props: MockProps) => React.createElement('icon', { name: 'EyeOff', ...props }),
  PackageOpen: (props: MockProps) => React.createElement('icon', { name: 'PackageOpen', ...props }),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/components/skeleton', () => ({
  CardListSkeleton: (props: MockProps) => React.createElement('card-list-skeleton', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: authUser.current, api: {} }),
}));

vi.mock('@/lib/use-media-source', () => ({ useMediaSource }));
vi.mock('@/lib/use-mature-reveal', () => ({ useMatureReveal }));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: () => query.current,
}));

import UnlocksScreen from '../app/unlocks';

const fetchNextPage = vi.fn();
const refetch = vi.fn();

function unlockRow(overrides: Record<string, unknown> = {}) {
  return {
    unlockId: 'unlock-1',
    title: 'Moody Bathroom Portrait Prompt Pack',
    creator: { displayName: 'fluffy' },
    purchasePriceUsdCents: 900,
    purchasedAt: '2026-08-12T00:00:00.000Z',
    detached: false,
    isNsfw: false,
    paidWith: 'credits',
    paidAmountSubunits: 900,
    paidCurrency: null,
    post: { mediaUrl: null, mediaKind: 'image', previewUrl: null, previewThumbhash: null },
    ...overrides,
  };
}

function loaded(items: unknown[], extra: Record<string, unknown> = {}) {
  query.current = {
    data: { pages: [{ items, pageInfo: { total: items.length, nextOffset: null } }] },
    error: null,
    fetchNextPage,
    hasNextPage: false,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    isLoading: false,
    refetch,
    ...extra,
  };
}

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(UnlocksScreen));
  });
  return tree;
}

function findRow(tree: renderer.ReactTestRenderer) {
  const row = tree.root.findAll((node) => String(node.type) === 'pressable'
    && String(node.props.accessibilityLabel ?? '').startsWith('Moody Bathroom'))[0];
  if (!row) throw new Error('No unlock row rendered');
  return row;
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text')
    .map((node) => [node.props.children].flat().join(''));
}

function images(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'image');
}

beforeEach(() => {
  authUser.current = { id: 'user-1' };
  platform.OS = 'ios';
  reveal.current = 'show';
  useMatureReveal.mockClear();
  routerPush.mockClear();
  routerDismissTo.mockClear();
  fetchNextPage.mockClear();
  refetch.mockClear();
  useMediaSource.mockClear();
  loaded([unlockRow()]);
});

describe('unlocks library (HIG S7)', () => {
  it('wires each row as a labelled button that opens its unlock', () => {
    const tree = renderScreen();
    const row = findRow(tree);

    expect(row.props.accessibilityRole).toBe('button');
    expect(String(row.props.accessibilityLabel)).toContain('by fluffy');
    expect(String(row.props.accessibilityLabel)).toContain('900 credits');

    renderer.act(() => { (row.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/unlock/unlock-1');
  });

  it('holds the thumbnail slot with the placeholder when a row has no media', () => {
    const tree = renderScreen();

    expect(tree.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'PackageOpen')).toHaveLength(1);
    expect(images(tree)).toHaveLength(0);
  });

  it('brings a signed-out reader back to the library after sign-in', () => {
    authUser.current = null;
    const tree = renderScreen();

    const signIn = tree.root.findAll((node) => String(node.type) === 'primary-button' && node.props.label === 'Sign in')[0];
    if (!signIn) throw new Error('No sign-in button');
    renderer.act(() => { (signIn.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/unlocks' } });
  });
});

describe('unlock thumbnails (03-3, 03-4)', () => {
  it('draws a private preview through the authenticated media source, with its thumbhash', () => {
    // An uploaded post's preview is a relative /api/media link: a bare
    // { uri } had neither the host nor the bearer, so the row showed the icon.
    const previewUrl = '/api/media?bucket=post_media&path=private-posts%2Fcreator%2Fpreview.webp';
    loaded([unlockRow({ post: { mediaUrl: null, mediaKind: 'video', previewUrl, previewThumbhash: 'thumb-1' } })]);
    const tree = renderScreen();

    expect(useMediaSource).toHaveBeenCalledWith(previewUrl);
    const [image] = images(tree);
    expect(image?.props.source).toEqual({
      uri: `https://api.test${previewUrl}`,
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(image?.props.placeholder).toEqual({ thumbhash: 'thumb-1' });
  });

  it('keeps the icon for a video with no poster, and never asks for its MP4', () => {
    loaded([unlockRow({ post: { mediaUrl: 'https://cdn.test/clip.mp4', mediaKind: 'video', previewUrl: null, previewThumbhash: null } })]);
    const tree = renderScreen();

    expect(images(tree)).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'PackageOpen')).toHaveLength(1);
    expect(useMediaSource).not.toHaveBeenCalledWith('https://cdn.test/clip.mp4');
  });

  it('falls back to the original of a picture post', () => {
    loaded([unlockRow({ post: { mediaUrl: '/api/media?bucket=post_media&path=look.jpg', mediaKind: 'image', previewUrl: null, previewThumbhash: null } })]);
    const tree = renderScreen();

    expect(images(tree)[0]?.props.source).toEqual(expect.objectContaining({ uri: 'https://api.test/api/media?bucket=post_media&path=look.jpg' }));
  });
});

describe('mature unlocks', () => {
  const matureRow = () => unlockRow({
    isNsfw: true,
    post: { mediaUrl: null, mediaKind: 'image', previewUrl: '/api/media?bucket=post_media&path=still.webp', previewThumbhash: 'thumb-1' },
  });
  const showControls = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll((node) => node.props.accessibilityLabel === 'Show mature content');

  it('covers the thumbnail with a plate, and draws it in place on Show without opening the unlock', () => {
    loaded([matureRow()]);
    const tree = renderScreen();

    expect(images(tree)).toHaveLength(0);
    expect(texts(tree)).toContain('Mature content');
    expect(String(findRow(tree).props.accessibilityLabel)).toContain('Mature content');
    const show = tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Show mature content');

    renderer.act(() => { (show.props.onPress as () => void)(); });

    expect(images(tree)[0]?.props.source).toEqual(expect.objectContaining({ uri: 'https://api.test/api/media?bucket=post_media&path=still.webp' }));
    expect(showControls(tree)).toHaveLength(0);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('offers a screen reader the same Show as an action on the row', () => {
    loaded([matureRow()]);
    const tree = renderScreen();
    const row = findRow(tree);
    expect(row.props.accessibilityActions).toEqual([{ name: 'showMature', label: 'Show mature content' }]);

    renderer.act(() => {
      (row.props.onAccessibilityAction as (event: unknown) => void)({ nativeEvent: { actionName: 'showMature' } });
    });

    expect(images(tree)).toHaveLength(1);
    // Empty, not undefined: Android keeps the actions a view had when the prop
    // goes back to undefined (hig-accessibility-label-states.test.ts).
    expect(findRow(tree).props.accessibilityActions).toEqual([]);
  });

  it('asks for the preference only for a row with a mature still to cover', () => {
    loaded([matureRow(), unlockRow({ unlockId: 'unlock-2', isNsfw: true, post: null }), unlockRow({ unlockId: 'unlock-3' })]);
    renderScreen();

    expect(useMatureReveal.mock.calls.map(([needed]) => needed)).toEqual([true, false, false]);
  });

  it('offers no Show on iOS while the website preference is off or still being read', () => {
    for (const state of ['website', 'pending'] as const) {
      reveal.current = state;
      loaded([matureRow()]);
      const tree = renderScreen();

      expect(images(tree)).toHaveLength(0);
      expect(showControls(tree)).toHaveLength(0);
      expect(tree.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'EyeOff')).toHaveLength(1);
      expect(findRow(tree).props.accessibilityActions).toEqual([]);
      expect(texts(tree)).toContain('Mature content');
    }
  });

  it('covers the still again when the preference is turned off on the website', () => {
    loaded([matureRow()]);
    const tree = renderScreen();
    renderer.act(() => { (showControls(tree)[0]!.props.onPress as () => void)(); });
    expect(images(tree)).toHaveLength(1);

    reveal.current = 'website';
    renderer.act(() => { tree.update(React.createElement(UnlocksScreen)); });

    expect(images(tree)).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'EyeOff')).toHaveLength(1);
  });

  it('keeps the plate up for good on Android, which shows no mature media', () => {
    platform.OS = 'android';
    reveal.current = 'never';
    loaded([matureRow()]);
    const tree = renderScreen();

    expect(images(tree)).toHaveLength(0);
    expect(showControls(tree)).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'EyeOff')).toHaveLength(1);
    expect(findRow(tree).props.accessibilityActions).toEqual([]);
  });
});

describe('what each row says it cost, and who left (03-2, 03-8)', () => {
  it('prints a cash purchase as a receipt in its own currency on Android', () => {
    platform.OS = 'android';
    loaded([unlockRow({ paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' })]);
    const tree = renderScreen();

    expect(texts(tree).some((line) => line.startsWith('₹750 paid · '))).toBe(true);
    expect(String(findRow(tree).props.accessibilityLabel)).toContain('₹750 paid');
  });

  it('says only "Paid" for a cash purchase on iOS, with no amount', () => {
    loaded([unlockRow({ paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' })]);
    const tree = renderScreen();

    expect(texts(tree).some((line) => line.startsWith('Paid · '))).toBe(true);
    expect(texts(tree).join(' ')).not.toMatch(/₹|INR|750/);
    expect(String(findRow(tree).props.accessibilityLabel)).toContain(' Paid.');
    expect(String(findRow(tree).props.accessibilityLabel)).not.toMatch(/₹|750/);
  });

  it('calls a free unlock free', () => {
    loaded([unlockRow({ paidWith: 'free', paidAmountSubunits: null, purchasePriceUsdCents: 0 })]);
    const tree = renderScreen();

    expect(texts(tree).some((line) => line.startsWith('Free · '))).toBe(true);
  });

  it('says the creator left on a row whose creator deleted their account', () => {
    loaded([unlockRow({ detached: true, post: null })]);
    const tree = renderScreen();

    expect(texts(tree)).toContain('Creator left');
  });
});

describe('loading and empty states (03-6, 03-10)', () => {
  it('keeps the loaded rows when a later page fails, and offers Retry by the button', () => {
    loaded([unlockRow()], {
      hasNextPage: true,
      isFetchNextPageError: true,
      error: new Error('Network request failed. Please check your connection and try again.'),
    });
    const tree = renderScreen();

    expect(findRow(tree)).toBeTruthy();
    const blocks = tree.root.findAll((node) => String(node.type) === 'status-block');
    expect(blocks.map((node) => node.props.title)).toEqual(['Could not load more recipes']);
    expect(blocks[0]?.props.body).toBe('Network request failed. Please check your connection and try again.');
    const retry = tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === 'Retry');
    renderer.act(() => { (retry.props.onPress as () => void)(); });
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('says Loading… on the button while that page is asked for again', () => {
    loaded([unlockRow()], { hasNextPage: true, isFetchNextPageError: true, isFetchingNextPage: true, error: new Error('offline') });
    const tree = renderScreen();

    expect(tree.root.findAll((node) => String(node.type) === 'status-block')).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'secondary-button').map((node) => node.props.label)).toContain('Loading…');
  });

  it('shows the first-load failure only when nothing loaded', () => {
    query.current = { ...query.current, data: undefined, error: new Error('offline') };
    const tree = renderScreen();

    expect(tree.root.findAll((node) => String(node.type) === 'status-block').map((node) => node.props.title))
      .toEqual(['Could not load your recipes']);
    const retry = tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === 'Retry recipes');
    renderer.act(() => { (retry.props.onPress as () => void)(); });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('gives an empty library a way on to browse recipes', () => {
    loaded([]);
    const tree = renderScreen();

    expect(tree.root.findAll((node) => String(node.type) === 'status-block').map((node) => node.props.title)).toEqual(['No recipes yet']);
    const browse = tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === 'Browse recipes');
    renderer.act(() => { (browse.props.onPress as () => void)(); });
    expect(routerDismissTo).toHaveBeenCalledWith('/(tabs)');
  });
});
