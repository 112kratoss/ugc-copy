(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

// A remix's credit line opens its post or creator through the router (`RemixCreditLine`).
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('react-native', () => {
  const animatedValue = () => ({
    interpolate: () => 0,
    setValue: () => undefined,
    stopAnimation: () => undefined,
  });
  return {
    ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
    Animated: {
      Value: function Value() { return animatedValue(); },
      View: ({ children, ...props }: MockProps) => React.createElement('animated-view', props, children),
      multiply: () => 1,
      sequence: () => ({ start: () => undefined }),
      timing: () => ({ start: () => undefined }),
    },
    Easing: { out: () => undefined, quad: undefined, cubic: undefined },
    Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
    Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
      ...props,
      style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
    }, children),
    Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  };
});
vi.mock('expo-image', () => ({ Image: (props: MockProps) => React.createElement('image', props) }));
vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return {
    ArrowLeft: icon('arrow-left'),
    ChevronLeft: icon('chevron-left'),
    Eye: icon('eye'),
    FileText: icon('file'),
    Globe: icon('globe'),
    Heart: icon('heart'),
    Images: icon('images'),
    Lock: icon('lock'),
    LockKeyhole: icon('lock-keyhole'),
    MessageCircle: icon('message'),
    MoreHorizontal: icon('more'),
    Repeat2: icon('repeat'),
    Share: icon('share'),
    Share2: icon('share'),
    Wand2: icon('wand'),
    X: icon('x'),
  };
});
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/components/reel-icon', () => ({ renderReelIcon: (icon: React.ReactElement) => icon }));
vi.mock('@/components/viewer-actions-menu', () => ({
  ViewerActionsMenu: ({ renderButton }: { renderButton: (onPress: () => void) => React.ReactElement }) => renderButton(() => undefined),
}));

import { ReelSlideChrome } from '../components/reel-chrome';
import { viewCountLabels } from '../lib/view-count/view-count';

function reelItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-1',
    source: 'showcase-feed',
    sourceType: 'showcase',
    title: 'Neon portrait',
    displayText: 'Neon portrait',
    mediaUrl: 'https://cdn.test/a.jpg',
    mediaKind: 'image',
    mediaItems: [],
    creatorLabel: '@luna',
    creatorAvatar: null,
    creatorUsername: 'luna',
    badge: '900 credits',
    saveLabel: 'Save',
    saveCount: 0,
    commentLabel: '0',
    commentCount: 0,
    canComment: true,
    isSaved: false,
    canSave: true,
    canShare: true,
    sharePath: '/showcase/post-1',
    recreateTool: 'image',
    recreatePrompt: 'neon portrait',
    remixAccess: 'paid-unlock',
    showcasePostId: 'post-1',
    generationId: 'gen-1',
    ownerPostId: null,
    availableActions: ['save', 'comment', 'share', 'unlock-remix', 'view-details'],
    disabledActions: {},
    details: {
      title: 'Neon portrait',
      prompt: '',
      body: '',
      categoryLabel: 'Image',
      sourceLabel: 'Showcase',
      creatorLabel: '@luna',
      creatorAvatar: null,
      saveCount: 0,
      remixCount: 0,
      unlock: {
        resourceId: 'asset-1',
        postId: 'post-1',
        title: 'Neon kit',
        accessMode: 'paid',
        priceLabel: '900 credits',
        previewText: null,
        resourceKinds: ['prompt', 'remix'],
        allowRemix: true,
      },
    },
    ...overrides,
  } as ImmersivePreviewItem;
}

function renderRail(item: ImmersivePreviewItem, handlers: { onUnlockRemix?: () => void; onRecreate?: () => void } = {}) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <ReelSlideChrome
        item={item}
        topInset={0}
        bottomInset={0}
        pageIndex={0}
        follow={null}
        captionExpanded={false}
        onToggleCaption={vi.fn()}
        saveLoading={false}
        remixLoading={false}
        onSave={vi.fn()}
        onComments={vi.fn()}
        onShare={vi.fn()}
        onOpenDetails={vi.fn()}
        onUnlockRemix={handlers.onUnlockRemix ?? vi.fn()}
        onRecreate={handlers.onRecreate ?? vi.fn()}
        onActionsOpen={vi.fn()}
        onCreatorOpen={vi.fn()}
      />,
    );
  });
  return tree;
}

/** The rail from top to bottom: each button by its label, the views as `views`. */
function railOrder(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => (String(node.type) === 'pressable' && typeof node.props.accessibilityLabel === 'string')
      || (String(node.type) === 'view' && node.props.testID === 'reel-view-count'))
    .map((node) => (String(node.type) === 'view' ? 'views' : node.props.accessibilityLabel as string));
}

// Post view counts (step 3): the reel draws a post's views under its saves and
// comments, as information, never a button.
describe("the reel rail's views", () => {
  const open = { remixAccess: 'open' as const, availableActions: ['save', 'comment', 'share', 'recreate', 'view-details'] };

  it('draws the views under Save and Comment, before Share, with the whole number spoken', () => {
    const tree = renderRail(reelItem({ ...open, commentCount: 2, commentLabel: '2', viewLabels: viewCountLabels(1234) }));
    expect(railOrder(tree).slice(0, 4)).toEqual(['Save', '2 comments', 'views', 'Share']);

    const count = tree.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'reel-view-count')[0];
    expect(count.props).toMatchObject({ accessible: true, accessibilityRole: 'text', accessibilityLabel: '1,234 views' });
    expect(count.props.onPress).toBeUndefined();
    // No button holds it.
    expect(tree.root.findAll((node) => String(node.type) === 'pressable').some((button) => button.findAll((node) => node === count).length > 0)).toBe(false);
    expect(count.findAll((node) => String(node.type) === 'eye-icon')).toHaveLength(1);
    expect(count.findAll((node) => String(node.type) === 'text').map((node) => node.props.children)).toEqual(['1.2K']);
  });

  it('draws nothing where there are no views to show', () => {
    expect(railOrder(renderRail(reelItem({ ...open, viewLabels: null })))).not.toContain('views');
    expect(railOrder(renderRail(reelItem({ ...open, viewLabels: viewCountLabels(0) })))).not.toContain('views');
  });

  it('keeps its place under Save on a post that takes no comments', () => {
    const tree = renderRail(reelItem({
      ...open,
      canComment: false,
      availableActions: ['save', 'share', 'recreate', 'view-details'],
      viewLabels: viewCountLabels(7),
    }));
    expect(railOrder(tree).slice(0, 3)).toEqual(['Save', 'views', 'Share']);
  });
});
