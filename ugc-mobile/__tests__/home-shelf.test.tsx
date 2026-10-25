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
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
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

function renderShelf(items: HomeShelfItem[], overrides: Partial<React.ComponentProps<typeof HomeShelf>> = {}) {
  const onMake = vi.fn();
  const tree = render(
    <HomeShelf
      items={items}
      isLoading={false}
      offerFreeToTry={false}
      horizontalPadding={18}
      contentWidth={354}
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
    // A row that scrolls sideways, held still: nothing in it turns by itself.
    expect(tree.root.find((node) => String(node.type) === 'scrollview').props.horizontal).toBe(true);
  });

  it('hands a creation to the screen to remix, and opens an offer\'s screen', () => {
    const { tree, onMake } = renderShelf(shelf.responseVariants.member.response.items);
    const byLabel = (label: string) => pressables(tree).find((node) => String(node.props.accessibilityLabel).startsWith(label))!;

    renderer.act(() => {
      byLabel('Paper boat').props.onPress();
      byLabel('Share your first post').props.onPress();
      byLabel('Invite friends').props.onPress();
      byLabel('New motion').props.onPress();
      byLabel('See all creations').props.onPress();
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

  it('holds its place while the first answer loads', () => {
    const { tree } = renderShelf([], { isLoading: true });

    expect(pressables(tree).map((node) => node.props.accessibilityLabel)).toEqual(['See all creations']);
    const placeholders = tree.root.findAll((node) => String(node.type) === 'view' && node.props.accessible === false);
    expect(placeholders).toHaveLength(3);
    expect(tree.root.find((node) => String(node.type) === 'scrollview').props.scrollEnabled).toBe(false);
  });

  it('draws nothing when there is nothing to show', () => {
    const { tree } = renderShelf([]);

    expect(tree.toJSON()).toBeNull();
  });

  it('gives every control a full hit region', () => {
    const { tree } = renderShelf(shelf.responseVariants.member.response.items);

    for (const node of pressables(tree)) {
      const style = (node.props.style ?? {}) as { height?: number; minHeight?: number };
      const slop = (node.props.hitSlop ?? { top: 0, bottom: 0 }) as { top: number; bottom: number };
      const drawn = style.height ?? style.minHeight;
      if (drawn === undefined) {
        // "See all" is a text link: its slop is sized for its line.
        expect(slop.top + slop.bottom).toBeGreaterThan(0);
        continue;
      }
      expect(drawn + slop.top + slop.bottom, String(node.props.accessibilityLabel)).toBeGreaterThanOrEqual(MIN_HIT_TARGET_PT);
    }
  });
});
