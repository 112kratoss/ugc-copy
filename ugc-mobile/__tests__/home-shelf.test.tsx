(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const routerPush = vi.hoisted(() => vi.fn());
// Reduce Motion and Settings → Playback → Autoplay previews, as a test sets them.
const playbackSettings = vi.hoisted(() => ({ previewsAllowed: true }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('expo-router', () => ({ router: { push: routerPush } }));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement('icon', { ...props, name });
  return {
    Coins: icon('Coins'),
    Gift: icon('Gift'),
    ImageIcon: icon('ImageIcon'),
    Play: icon('Play'),
    Rocket: icon('Rocket'),
    Send: icon('Send'),
    Video: icon('Video'),
  };
});

// The poster, the bones, the feed's video tile and the type have suites of
// their own; here they are the props the shelf hands them.
vi.mock('@/components/media-preview', () => ({
  StableMediaImage: (props: MockProps) => React.createElement('stable-image', props),
}));
vi.mock('@/components/feed-video-preview', () => ({
  FeedVideoPreview: (props: MockProps) => React.createElement('feed-video-preview', props),
}));
vi.mock('@/lib/use-preview-playback-allowed', () => ({
  usePreviewPlaybackAllowed: () => playbackSettings.previewsAllowed,
}));
vi.mock('@/components/skeleton', () => ({
  SkeletonBone: (props: MockProps) => React.createElement('skeleton-bone', props),
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  usePressMotion: () => ({ animatedStyle: {}, onPressIn: vi.fn(), onPressOut: vi.fn() }),
}));

vi.mock('@/lib/theme-context', async () => {
  const { themes } = await import('../lib/theme');
  return { useAppTheme: () => themes.dark };
});

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { HomeShelf } from '../components/home-shelf';
import { createFeedVideoActivationStore, FeedVideoActivationContext, type FeedVideoActivationStore } from '../lib/feed-video-activation';
import { MIN_HIT_TARGET_PT } from '../lib/hit-target';
import { SHOWCASE_SETTLE_CONFIRM_MS } from '../lib/showcase-feed-activation';
import type { HomeShelfCreation, HomeShelfItem, HomeShelfResponse } from '../lib/types';

const shelf = mobileApiContract.endpoints.getHomeShelf as unknown as {
  response: HomeShelfResponse;
  responseVariants: { member: { response: HomeShelfResponse } };
};

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

const pressables = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'pressable');
const allText = (node: renderer.ReactTestInstance) => node.findAll((child) => String(child.type) === 'text')
  .map((child) => child.props.children)
  .join(' | ');
const byLabel = (tree: renderer.ReactTestRenderer, label: string) => (
  pressables(tree).find((node) => String(node.props.accessibilityLabel).startsWith(label))!
);

function renderShelf(items: HomeShelfItem[], overrides: Partial<React.ComponentProps<typeof HomeShelf>> = {}) {
  const onMake = vi.fn();
  const tree = render(
    <HomeShelf
      items={items}
      isLoading={false}
      offerFreeToTry={false}
      horizontalPadding={18}
      contentWidth={354}
      activeRenders={0}
      pendingId={null}
      onMake={onMake}
      {...overrides}
    />,
  );
  return { tree, onMake };
}

beforeEach(() => {
  routerPush.mockReset();
  playbackSettings.previewsAllowed = true;
});

describe('the Make this shelf', () => {
  it('draws the cards in the order the server sent them, then the tools', () => {
    const { tree } = renderShelf(shelf.responseVariants.member.response.items);

    expect(pressables(tree).map((node) => node.props.accessibilityLabel)).toEqual([
      'See all creations',
      'Paper boat on a sunlit pond, Grok Imagine, 15 credits, by @magicbooklet',
      'Serum on a stone pedestal, Nano Banana Pro, 18 credits, by @magicbooklet',
      'Share your first post. Post a creation or a tip to the feed.',
      'Make anyone dance, New model, Kling 3.0 Motion, Priced by clip length, by @magicbooklet',
      'Invite friends, earn credits. You get 5% of their top-ups in credits. They get 5% extra on their first.',
      'New image',
      'New video',
      'New motion',
    ]);
    expect(allText(tree.root)).toContain('Make this');
    expect(tree.root.find((node) => String(node.type) === 'scrollview').props.horizontal).toBe(true);
  });

  it('reads a card its badge, and tells a guest that Make this signs in first', () => {
    const member = renderShelf(shelf.responseVariants.member.response.items).tree;
    expect(byLabel(member, 'Paper boat').props.accessibilityLabel).not.toContain('Free to try');
    expect(byLabel(member, 'Paper boat').props.accessibilityHint).toBe('Opens the creator with this prompt and settings');

    const guest = renderShelf(shelf.response.items, { offerFreeToTry: true, signsInFirst: true }).tree;
    expect(byLabel(guest, 'Paper boat').props.accessibilityLabel)
      .toBe('Paper boat on a sunlit pond, Free to try, Grok Imagine, 15 credits, by @magicbooklet');
    expect(byLabel(guest, 'Paper boat').props.accessibilityHint)
      .toBe('Opens sign-in, then the creator with this prompt and settings');
  });

  it("hands a creation to the screen to remix, and opens an offer's screen", () => {
    const { tree, onMake } = renderShelf(shelf.responseVariants.member.response.items);

    renderer.act(() => {
      byLabel(tree, 'Paper boat').props.onPress();
      byLabel(tree, 'Share your first post').props.onPress();
      byLabel(tree, 'Invite friends').props.onPress();
      byLabel(tree, 'New motion').props.onPress();
      byLabel(tree, 'See all creations').props.onPress();
    });

    expect(onMake).toHaveBeenCalledTimes(1);
    expect((onMake.mock.calls[0][0] as HomeShelfCreation).post.id).toBe('post-1');
    expect(routerPush.mock.calls.map(([route]) => route)).toEqual(['/post/new', '/invite', '/create/motion', '/(tabs)/showcase']);
  });

  it('says "Free to try" only to someone still owed the welcome credits', () => {
    const offered = renderShelf(shelf.response.items, { offerFreeToTry: true }).tree;
    const member = renderShelf(shelf.response.items, { offerFreeToTry: false }).tree;

    expect(allText(offered.root)).toContain('Free to try');
    expect(allText(member.root)).not.toContain('Free to try');
    // The launch keeps its own badge either way.
    expect(allText(member.root)).toContain('New model');
  });

  it('holds its place with bones while the first answer loads', () => {
    const { tree } = renderShelf([], { isLoading: true });

    expect(pressables(tree)).toHaveLength(0);
    const progress = tree.root.find((node) => String(node.type) === 'view' && node.props.accessibilityRole === 'progressbar');
    expect(progress.props.accessibilityLabel).toBe('Loading creations');
    expect(progress.findAll((node) => String(node.type) === 'skeleton-bone')).toHaveLength(3);
    expect(tree.root.find((node) => String(node.type) === 'scrollview').props.scrollEnabled).toBe(false);
  });

  it('offers the three tools when there are no creations, in the same row', () => {
    const { tree } = renderShelf([]);

    expect(allText(tree.root)).toContain('Start creating');
    expect(pressables(tree).map((node) => node.props.accessibilityLabel)).toEqual(['New image', 'New video', 'New motion']);
    renderer.act(() => byLabel(tree, 'New video').props.onPress());
    expect(routerPush).toHaveBeenCalledWith('/create/video');
  });

  it("puts renders in progress in the subtitle's place, opening Creations", () => {
    const { tree } = renderShelf(shelf.response.items, { activeRenders: 2 });

    const line = byLabel(tree, '2 renders in progress');
    expect(line.props.accessibilityHint).toBe('Opens your creations');
    expect(allText(tree.root)).not.toContain('Real creations, one tap to make your own');
    renderer.act(() => line.props.onPress());
    expect(routerPush).toHaveBeenCalledWith({ pathname: '/profile', params: { tab: 'Creations' } });
  });

  it('waits on the remix being opened: that card says so, and no card takes a second tap', () => {
    const { tree } = renderShelf(shelf.response.items, { pendingId: 'post-1' });

    const opening = byLabel(tree, 'Paper boat');
    expect(opening.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(allText(opening)).toContain('Opening');
    expect(byLabel(tree, 'Serum').props.disabled).toBe(true);
  });

  it('gives every control a full hit region', () => {
    for (const items of [shelf.responseVariants.member.response.items, [] as HomeShelfItem[]]) {
      const { tree } = renderShelf(items, { activeRenders: items.length ? 1 : 0 });
      for (const node of pressables(tree)) {
        const style = (node.props.style ?? {}) as { height?: number; minHeight?: number };
        const slop = (node.props.hitSlop ?? { top: 0, bottom: 0 }) as { top: number; bottom: number };
        const drawn = style.height ?? style.minHeight ?? 0;
        expect(drawn + slop.top + slop.bottom, String(node.props.accessibilityLabel)).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
      }
    }
  });
});

describe("the shelf's clips", () => {
  const items = () => shelf.responseVariants.member.response.items;
  const inHome = (store: FeedVideoActivationStore, lineup: HomeShelfItem[], onPlaybackCandidateChange: () => void) => (
    <FeedVideoActivationContext.Provider value={store}>
      <HomeShelf
        items={lineup}
        isLoading={false}
        offerFreeToTry={false}
        horizontalPadding={18}
        contentWidth={354}
        activeRenders={0}
        pendingId={null}
        onMake={vi.fn()}
        onPlaybackCandidateChange={onPlaybackCandidateChange}
      />
    </FeedVideoActivationContext.Provider>
  );
  const renderInHome = (store: FeedVideoActivationStore, onPlaybackCandidateChange = vi.fn()) => {
    const tree = render(inHome(store, items(), onPlaybackCandidateChange));
    return { tree, onPlaybackCandidateChange };
  };
  const playGlyphs = (tree: renderer.ReactTestRenderer) => tree.root
    .findAll((node) => String(node.type) === 'icon' && node.props.name === 'Play');
  // Resting at `x` in a 390pt row, as a momentum end reports it.
  const restAt = (x: number) => ({ nativeEvent: { contentOffset: { x }, layoutMeasurement: { width: 390 } } });
  // One card step: a card (149pt at this width) and the gap after it.
  const STEP = 149 + 12;
  const clipTile = (tree: renderer.ReactTestRenderer, postId: string) => tree.root
    .findAll((node) => String(node.type) === 'feed-video-preview')
    .find((node) => node.props.streamUrl === items()
      .find((item): item is HomeShelfCreation => item.kind === 'creation' && item.id === postId)?.clipUrl)!;
  const rowOf = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => String(node.type) === 'scrollview');

  it("plays a card's clip only while it holds Home's one playing slot, under its own id", () => {
    const store = createFeedVideoActivationStore();
    const { tree } = renderInHome(store);

    expect(clipTile(tree, 'post-1').props).toMatchObject({
      active: false,
      prepared: false,
      retryable: false,
      height: '100%',
      // Shelf starts are not feed starts: the fleet's feed metrics leave them out.
      metricsSurface: null,
    });
    // The tool's own accent, as a hex the tile can add an alpha to.
    expect(clipTile(tree, 'post-1').props.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(playGlyphs(tree)).toHaveLength(2);

    // The feed's own card for the same post is not the shelf's.
    renderer.act(() => store.publish({ activeIds: ['post-1'] }));
    expect(clipTile(tree, 'post-1').props.active).toBe(false);

    renderer.act(() => store.publish({ activeIds: ['home-shelf:post-1'] }));
    expect(clipTile(tree, 'post-1').props.active).toBe(true);
    expect(clipTile(tree, 'post-3').props.active).toBe(false);
    // Elected, but its player has not drawn: the poster shows, with its glyph.
    expect(playGlyphs(tree)).toHaveLength(2);

    renderer.act(() => clipTile(tree, 'post-1').props.onReadyChange(true));
    expect(store.isReady('home-shelf:post-1')).toBe(true);
    // A playing clip wears no play glyph; the one waiting still does.
    expect(playGlyphs(tree)).toHaveLength(1);

    // A failure takes the frame away, and the glyph comes back with the poster.
    renderer.act(() => clipTile(tree, 'post-1').props.onReadyChange(false));
    expect(playGlyphs(tree)).toHaveLength(2);
  });

  it('keeps every clip on its poster where previews may not play (Reduce Motion, Autoplay previews off)', () => {
    playbackSettings.previewsAllowed = false;
    const store = createFeedVideoActivationStore();
    store.publish({ activeIds: ['home-shelf:post-1'] });
    const { tree } = renderInHome(store);

    expect(clipTile(tree, 'post-1').props.active).toBe(false);
  });

  it('shows posters alone outside Home, where no election runs', () => {
    const { tree } = renderShelf(items());

    expect(tree.root.findAll((node) => String(node.type) === 'feed-video-preview')).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'stable-image')).toHaveLength(3);
  });

  it('puts up the first clip card in view, and the next once the row rests on it', () => {
    const { tree, onPlaybackCandidateChange } = renderInHome(createFeedVideoActivationStore());
    // Nothing is in view before the row has a width.
    expect(onPlaybackCandidateChange).toHaveBeenLastCalledWith(null);

    renderer.act(() => rowOf(tree).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
    expect(onPlaybackCandidateChange.mock.lastCall?.[0]).toMatchObject({ id: 'home-shelf:post-1', mediaKind: 'video' });

    // Resting on the fourth card (the motion clip), three card steps along.
    renderer.act(() => rowOf(tree).props.onMomentumScrollEnd(restAt(3 * STEP)));
    expect(onPlaybackCandidateChange.mock.lastCall?.[0]).toMatchObject({ id: 'home-shelf:post-3' });

    const calls = onPlaybackCandidateChange.mock.calls.length;
    renderer.act(() => rowOf(tree).props.onMomentumScrollEnd(restAt(3 * STEP + 4)));
    // The same card: nothing new to tell.
    expect(onPlaybackCandidateChange.mock.calls).toHaveLength(calls);
  });

  it("waits out a finger's lift: the snap and any coast come first", () => {
    vi.useFakeTimers();
    try {
      const { tree, onPlaybackCandidateChange } = renderInHome(createFeedVideoActivationStore());
      const lastCandidate = () => onPlaybackCandidateChange.mock.lastCall?.[0];
      renderer.act(() => rowOf(tree).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
      expect(lastCandidate()).toMatchObject({ id: 'home-shelf:post-1' });

      // A fling: lifted at x 120, which shows no clip card, with momentum after it.
      const calls = onPlaybackCandidateChange.mock.calls.length;
      renderer.act(() => rowOf(tree).props.onScrollBeginDrag());
      renderer.act(() => rowOf(tree).props.onScrollEndDrag(restAt(120)));
      renderer.act(() => rowOf(tree).props.onMomentumScrollBegin());
      renderer.act(() => { vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS); });
      expect(onPlaybackCandidateChange.mock.calls).toHaveLength(calls);
      renderer.act(() => rowOf(tree).props.onMomentumScrollEnd(restAt(3 * STEP)));
      expect(lastCandidate()).toMatchObject({ id: 'home-shelf:post-3' });

      // A lift no momentum follows rests where iOS says the snap lands, once
      // the confirm window has passed with no momentum.
      renderer.act(() => rowOf(tree).props.onScrollBeginDrag());
      renderer.act(() => rowOf(tree).props.onScrollEndDrag({
        nativeEvent: { contentOffset: { x: 40 }, targetContentOffset: { x: 0, y: 0 }, layoutMeasurement: { width: 390 } },
      }));
      expect(lastCandidate()).toMatchObject({ id: 'home-shelf:post-3' });
      renderer.act(() => { vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS); });
      expect(lastCandidate()).toMatchObject({ id: 'home-shelf:post-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows a scroll with no finger in it (TalkBack, a keyboard) once it stops', () => {
    vi.useFakeTimers();
    try {
      const { tree, onPlaybackCandidateChange } = renderInHome(createFeedVideoActivationStore());
      renderer.act(() => rowOf(tree).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
      renderer.act(() => rowOf(tree).props.onScroll(restAt(2 * STEP)));
      renderer.act(() => rowOf(tree).props.onScroll(restAt(3 * STEP)));
      expect(onPlaybackCandidateChange.mock.lastCall?.[0]).toMatchObject({ id: 'home-shelf:post-1' });
      renderer.act(() => { vi.advanceTimersByTime(SHOWCASE_SETTLE_CONFIRM_MS); });
      expect(onPlaybackCandidateChange.mock.lastCall?.[0]).toMatchObject({ id: 'home-shelf:post-3' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes over a clip that failed, until the lineup changes', () => {
    const store = createFeedVideoActivationStore();
    const onPlaybackCandidateChange = vi.fn();
    const lineup = items();
    const tree = render(inHome(store, lineup, onPlaybackCandidateChange));
    renderer.act(() => rowOf(tree).props.onLayout({ nativeEvent: { layout: { width: 390 } } }));
    expect(onPlaybackCandidateChange.mock.lastCall?.[0]).toMatchObject({ id: 'home-shelf:post-1' });

    renderer.act(() => clipTile(tree, 'post-1').props.onPlaybackFailed());
    // No other clip card in view: the slot goes back to the feed.
    expect(onPlaybackCandidateChange).toHaveBeenLastCalledWith(null);
    renderer.act(() => rowOf(tree).props.onMomentumScrollEnd(restAt(3 * STEP)));
    expect(onPlaybackCandidateChange.mock.lastCall?.[0]).toMatchObject({ id: 'home-shelf:post-3' });
    renderer.act(() => rowOf(tree).props.onMomentumScrollEnd(restAt(0)));
    expect(onPlaybackCandidateChange).toHaveBeenLastCalledWith(null);

    // A new answer from the server is a new lineup: its clips all get a try.
    renderer.act(() => tree.update(inHome(store, [...lineup], onPlaybackCandidateChange)));
    expect(onPlaybackCandidateChange.mock.lastCall?.[0]).toMatchObject({ id: 'home-shelf:post-1' });
  });
});
