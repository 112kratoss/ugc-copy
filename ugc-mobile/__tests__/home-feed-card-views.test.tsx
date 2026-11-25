(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { NativeMenuModel } from '../lib/native-menu';
import type { ShowcaseFeedItem } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return Object.fromEntries([
    'ArrowLeft', 'CheckCircle2', 'ChevronLeft', 'Eye', 'FileText', 'Globe', 'Heart', 'Images', 'Lock', 'LockKeyhole',
    'MessageCircle', 'MoreHorizontal', 'Repeat2', 'Share', 'Share2', 'ShoppingBag', 'Wand2', 'X',
  ].map((name) => [name, icon(name)]));
});
// The shell draws only the card's row of actions here, as it would under the post.
vi.mock('@/components/feed-card-shell', () => ({
  FeedCardShell: (props: { actions: React.ReactNode }) => React.createElement('actions', null, props.actions),
  FeedCardAction: ({ label, accessibilityLabel }: { label?: string; accessibilityLabel: string }) =>
    React.createElement('feed-card-action', { label, accessibilityLabel }),
}));
vi.mock('@/components/native-menu', () => ({ NativeMenu: () => null }));
vi.mock('@/components/media-zoom', () => ({
  MediaZoomSourceView: ({ children }: MockProps) => React.createElement(React.Fragment, null, children),
  useMediaZoomSource: () => ({ capture: () => undefined, prepare: () => undefined, appleZoomId: null }),
}));
vi.mock('@/components/post-text-block', () => ({ PostReadMore: () => null, PostTextBlock: () => null }));
vi.mock('@/components/remix-credit-line', () => ({ RemixCreditLine: () => null }));
vi.mock('@/components/save-heart', () => ({ SaveHeart: () => null }));
vi.mock('@/components/showcase-media-preview', () => ({ ShowcaseMediaPreview: () => null }));

import { HomeFeedCardView } from '../components/home-feed-card';
import { showcaseToHomeFeedCard } from '../lib/home-feed-view-model';

/**
 * Post view counts (step 3): a Home card draws its post's views at the action
 * row's far end, in one box with the recipe chip, as the web's card does, so a
 * phone with no room for them puts the two under the actions together and
 * never pushes an action onto a line of its own. The views are a count, never
 * a control.
 */

function post(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: null,
    mediaKind: null,
    mediaItems: [],
    model: 'manual',
    title: 'Above the clouds',
    prompt: '',
    body: 'A road over the clouds.',
    category: 'text',
    postFormat: 'text',
    saveCount: 2,
    remixCount: 0,
    commentCount: 1,
    createdAt: '2026-11-25T08:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  } as ShowcaseFeedItem;
}

const freeRecipe = {
  id: 'asset-1',
  postId: 'post-1',
  title: 'Cloud road recipe',
  accessMode: 'free',
  priceUsdCents: 0,
  previewText: null,
  allowRemix: false,
} as unknown as NonNullable<ShowcaseFeedItem['asset']>;

function renderCard(item: ShowcaseFeedItem) {
  const noop = () => undefined;
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <HomeFeedCardView
        card={showcaseToHomeFeedCard(item, new Date('2026-11-25T10:00:00.000Z'))}
        contentWidth={328}
        onOpen={noop}
        onReadMore={noop}
        onFeedbackOpen={noop}
        feedbackMenu={{ sections: [] } as unknown as NativeMenuModel}
        onCreatorOpen={noop}
        onSave={noop}
        onComments={noop}
        onRemix={noop}
        onShare={noop}
        onAssetPress={noop}
      />,
    );
  });
  return tree;
}

/** The row from left to right: each action by its label, the views as `views`, the far end's box last, as `[…]`. */
function row(tree: renderer.ReactTestRenderer): unknown[] {
  const isEntry = (node: renderer.ReactTestInstance) => String(node.type) === 'feed-card-action'
    || (String(node.type) === 'view' && node.props.testID === 'post-view-count');
  const name = (node: renderer.ReactTestInstance) => (String(node.type) === 'feed-card-action'
    ? node.props.label ?? node.props.accessibilityLabel
    : 'views');
  const actions = tree.root.findByType('actions' as never);
  const entries = actions.findAll(isEntry);
  const end = actions.findAll((node) => String(node.type) === 'view' && node.props.testID === 'home-feed-card-row-end')[0];
  const inEnd = new Set(end ? end.findAll(isEntry) : []);
  const before = entries.filter((node) => !inEnd.has(node));
  // The box is the row's last child: nothing of the row comes after its entries.
  if (end) expect(entries.slice(before.length)).toEqual([...inEnd]);
  return [...before.map(name), ...(end ? [[...inEnd].map(name)] : [])];
}

describe("a Home card's views", () => {
  it('carries the shared figures: nothing at 0 or with no count, "1.2K" drawn, the whole number spoken', () => {
    expect(showcaseToHomeFeedCard(post({ viewCount: 1234 })).viewLabels).toEqual({
      count: 1234, compact: '1.2K', visible: '1.2K views', spoken: '1,234 views',
    });
    expect(showcaseToHomeFeedCard(post({ viewCount: 0 })).viewLabels).toBeNull();
    expect(showcaseToHomeFeedCard(post()).viewLabels).toBeNull();
  });

  it('ends the row with the views, pushed to its far end, as no button', () => {
    const tree = renderCard(post({ viewCount: 1234 }));
    expect(row(tree)).toEqual(['2', '1', 'Share Above the clouds', ['views']]);

    const end = tree.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'home-feed-card-row-end')[0];
    expect(end.props.style).toMatchObject({ marginLeft: 'auto', flexDirection: 'row' });
    const count = end.findAll((node) => String(node.type) === 'view' && node.props.testID === 'post-view-count')[0];
    expect(count.props).toMatchObject({ accessible: true, accessibilityRole: 'text', accessibilityLabel: '1,234 views' });
    expect(count.props.onPress).toBeUndefined();
    expect(count.findAll((node) => String(node.type) === 'text').map((node) => node.props.children)).toEqual(['1.2K']);
  });

  it('keeps the views and the recipe chip in one box at the far end, the views first', () => {
    const tree = renderCard(post({ viewCount: 56, asset: freeRecipe }));
    expect(row(tree).at(-1)).toEqual(['views', 'Free recipe']);
    // At the largest text sizes the box keeps to the card's width and puts the
    // chip under the views, both on the right (review of #929).
    const end = tree.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'home-feed-card-row-end')[0];
    expect(end.props.style).toMatchObject({ flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' });
  });

  it('puts the recipe chip at the far end alone where there are no views, and draws no box with neither', () => {
    expect(row(renderCard(post({ viewCount: 0, asset: freeRecipe }))).at(-1)).toEqual(['Free recipe']);
    const bare = renderCard(post({ viewCount: 0 }));
    expect(bare.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'home-feed-card-row-end')).toHaveLength(0);
  });
});
