(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

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
import { getLockedRemixRailLabel } from '../lib/immersive-preview-view-model';

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

function remixButton(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label)[0];
}

/**
 * Audit B-F15: the reel's Remix looked open when the remix was sold with the
 * recipe, and the tap opened a paywall nobody had been told about. The Home
 * card's pill draws the lock and the price; the rail now does too.
 */
describe('the reel rail Remix behind a paid recipe', () => {
  it('names the price, and says what the tap does, as the Home card does', () => {
    expect(getLockedRemixRailLabel(reelItem())).toEqual({
      label: '900 credits',
      accessibilityLabel: 'Unlock Neon portrait to remix it, 900 credits',
    });
  });

  it('reads plain Remix where the price is not known, and nothing for a Remix that opens', () => {
    const details = reelItem().details!;
    expect(getLockedRemixRailLabel(reelItem({ details: { ...details, unlock: null } }))).toEqual({
      label: 'Remix',
      accessibilityLabel: 'Unlock Neon portrait to remix it',
    });
    expect(getLockedRemixRailLabel(reelItem({ availableActions: ['save', 'recreate', 'view-details'] }))).toBeNull();
  });

  it('draws the lock and the price on the rail, and opens the unlock', () => {
    const onUnlockRemix = vi.fn();
    const tree = renderRail(reelItem(), { onUnlockRemix });

    const button = remixButton(tree, 'Unlock Neon portrait to remix it, 900 credits');
    expect(button).toBeDefined();
    expect(button!.findAll((node) => String(node.type) === 'lock-icon')).toHaveLength(1);
    expect(button!.findAll((node) => String(node.type) === 'repeat-icon')).toHaveLength(0);
    expect(button!.findAll((node) => String(node.type) === 'text').map((node) => node.props.children)).toEqual(['900 credits']);

    renderer.act(() => button!.props.onPress());
    expect(onUnlockRemix).toHaveBeenCalledTimes(1);
  });

  it('keeps the open Remix as it was', () => {
    const onRecreate = vi.fn();
    const tree = renderRail(reelItem({ remixAccess: 'open', availableActions: ['save', 'comment', 'share', 'recreate', 'view-details'] }), { onRecreate });

    const button = remixButton(tree, 'Remix');
    expect(button).toBeDefined();
    expect(button!.findAll((node) => String(node.type) === 'repeat-icon')).toHaveLength(1);
    expect(button!.findAll((node) => String(node.type) === 'lock-icon')).toHaveLength(0);
  });
});
