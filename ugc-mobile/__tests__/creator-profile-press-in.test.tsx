(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeFeedCard } from '../lib/home-feed-view-model';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import type { ShowcaseFeedItem } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const { shell } = vi.hoisted(() => ({ shell: { props: null as Record<string, unknown> | null } }));

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
vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return Object.fromEntries([
    'ArrowLeft', 'CheckCircle2', 'ChevronLeft', 'FileText', 'Globe', 'Heart', 'Images', 'Lock', 'LockKeyhole',
    'MessageCircle', 'MoreHorizontal', 'Repeat2', 'Share', 'Share2', 'ShoppingBag', 'Wand2', 'X',
  ].map((name) => [name, icon(name)]));
});
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/components/reel-icon', () => ({ renderReelIcon: (icon: React.ReactElement) => icon }));
vi.mock('@/components/viewer-actions-menu', () => ({
  ViewerActionsMenu: ({ renderButton }: { renderButton: (onPress: () => void) => React.ReactElement }) => renderButton(() => undefined),
}));
// The Home card's own chrome is not the subject: only what it hands the shell.
vi.mock('@/components/feed-card-shell', () => ({
  FeedCardShell: (props: Record<string, unknown>) => {
    shell.props = props;
    return null;
  },
  FeedCardAction: () => null,
}));
vi.mock('@/components/native-menu', () => ({ NativeMenu: () => null }));
vi.mock('@/components/media-zoom', () => ({
  MediaZoomSourceView: ({ children }: MockProps) => React.createElement(React.Fragment, null, children),
  useMediaZoomSource: () => ({ capture: () => undefined, prepare: () => undefined, appleZoomId: null }),
}));
vi.mock('@/components/post-text-block', () => ({ PostReadMore: () => null, PostTextBlock: () => null }));
vi.mock('@/components/save-heart', () => ({ SaveHeart: () => null }));
vi.mock('@/components/showcase-media-preview', () => ({ ShowcaseMediaPreview: () => null }));

import { HomeFeedCardView } from '../components/home-feed-card';
import { ReelSlideChrome } from '../components/reel-chrome';
import { setCreatorProfilePreparer } from '../lib/creator-profile-opening';

/** The handles the root preparer was handed, in order. */
const prepared: string[] = [];
let removePreparer: () => void = () => undefined;

beforeEach(() => {
  removePreparer = setCreatorProfilePreparer((username) => {
    prepared.push(username);
  });
});

afterEach(() => {
  removePreparer();
  prepared.length = 0;
  shell.props = null;
});

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
    badge: 'Remix',
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
    remixAccess: 'open',
    showcasePostId: 'post-1',
    generationId: null,
    ownerPostId: null,
    availableActions: ['save', 'comment', 'share'],
    disabledActions: {},
    ...overrides,
  } as ImmersivePreviewItem;
}

function renderReelChrome(item: ImmersivePreviewItem, onCreatorOpen = vi.fn()) {
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
        onUnlockRemix={vi.fn()}
        onRecreate={vi.fn()}
        onActionsOpen={vi.fn()}
        onCreatorOpen={onCreatorOpen}
      />,
    );
  });
  return tree;
}

const creatorRow = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => (
  String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Open @luna profile'
));

// iPhone simulator, 2026-11-03: the page's read began only once it had
// mounted, and a creator opened from a reel drew a skeleton to +1100–1750 ms.
describe("a finger landing on a reel slide's creator", () => {
  it('starts reading their page before the press opens it', () => {
    const onCreatorOpen = vi.fn();
    const tree = renderReelChrome(reelItem(), onCreatorOpen);

    renderer.act(() => (creatorRow(tree).props.onPressIn as () => void)());
    expect(prepared).toEqual(['luna']);
    expect(onCreatorOpen).not.toHaveBeenCalled();

    renderer.act(() => (creatorRow(tree).props.onPress as () => void)());
    expect(onCreatorOpen).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  it('reads nothing for a slide whose creator has no page to open', () => {
    const tree = renderReelChrome(reelItem({ creatorUsername: null }));
    const row = creatorRow(tree);

    expect(row.props.disabled).toBe(true);
    renderer.act(() => (row.props.onPressIn as () => void)());
    expect(prepared).toEqual([]);
    renderer.act(() => tree.unmount());
  });
});

describe("a finger landing on a Home card's creator", () => {
  function homeCard(creator: ShowcaseFeedItem['creator']): HomeFeedCard {
    const item: ShowcaseFeedItem = {
      id: 'post-1',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      title: 'A launch frame',
      prompt: '',
      body: 'A launch frame',
      category: 'text',
      postFormat: 'text',
      saveCount: 0,
      remixCount: 0,
      commentCount: 0,
      createdAt: '2026-11-03T08:00:00.000Z',
      creator,
      generationId: null,
      asset: null,
      canRemix: false,
    };
    return {
      id: 'post-1',
      item,
      previewKind: 'text',
      mediaUrl: null,
      bodyText: null,
      title: 'A launch frame',
      accent: 'image',
      categoryLabel: 'Text',
      creatorAvatar: creator.avatar,
      creatorLabel: '@luna',
      creatorName: creator.name,
      timeLabel: '2h',
      isSaved: false,
      saveLabel: 'Save',
      commentLabel: '0',
      remixAccess: null,
      recipeChip: null,
    } as unknown as HomeFeedCard;
  }

  function renderHomeCard(card: HomeFeedCard) {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <HomeFeedCardView
          card={card}
          contentWidth={390}
          onOpen={vi.fn()}
          onReadMore={vi.fn()}
          onFeedbackOpen={vi.fn()}
          feedbackMenu={{ quickActions: [], sections: [] }}
          onCreatorOpen={vi.fn()}
          onSave={vi.fn()}
          onComments={vi.fn()}
          onRemix={vi.fn()}
          onShare={vi.fn()}
          onAssetPress={vi.fn()}
        />,
      );
    });
    return tree;
  }

  it('starts reading their page under the handle the card opens it with', () => {
    const tree = renderHomeCard(homeCard({ id: 'creator-1', username: ' luna ', name: 'Luna Studio', avatar: null }));

    renderer.act(() => (shell.props?.onCreatorPressIn as () => void)());
    expect(prepared).toEqual(['luna']);
    renderer.act(() => tree.unmount());
  });

  it('reads nothing for a creator with no handle, whose page the card cannot open', () => {
    const tree = renderHomeCard(homeCard({ id: 'creator-1', username: null, name: 'Luna Studio', avatar: null }));

    renderer.act(() => (shell.props?.onCreatorPressIn as () => void)());
    expect(prepared).toEqual([]);
    renderer.act(() => tree.unmount());
  });
});
