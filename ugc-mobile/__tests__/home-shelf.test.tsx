(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const routerPush = vi.hoisted(() => vi.fn());

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

// The poster, the bones and the type have suites of their own; here they are
// the props the shelf hands them.
vi.mock('@/components/media-preview', () => ({
  StableMediaImage: (props: MockProps) => React.createElement('stable-image', props),
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
import { MIN_HIT_TARGET_PT } from '../lib/hit-target';
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
});

describe('the Make this shelf', () => {
  it('draws the cards in the order the server sent them, then the tools', () => {
    const { tree } = renderShelf(shelf.responseVariants.member.response.items);

    expect(pressables(tree).map((node) => node.props.accessibilityLabel)).toEqual([
      'See all creations',
      'Paper boat on a sunlit pond, Grok Imagine, 15 credits, by @magicbooklet',
      'Serum on a stone pedestal, Nano Banana Pro, 18 credits, by @magicbooklet',
      'Share your first post. Post a creation or a tip to the feed.',
      'Make anyone dance, Kling 3.0 Motion, Priced by clip length, by @magicbooklet',
      'Invite friends, earn credits. You get 5% of their top-ups in credits. They get 5% extra on their first.',
      'New image',
      'New video',
      'New motion',
    ]);
    expect(allText(tree.root)).toContain('Make this');
    expect(tree.root.find((node) => String(node.type) === 'scrollview').props.horizontal).toBe(true);
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
