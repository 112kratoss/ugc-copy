(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeFeedCard } from '../lib/home-feed-view-model';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const { shell } = vi.hoisted(() => ({ shell: { props: null as Record<string, unknown> | null } }));

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
    'ArrowLeft', 'CheckCircle2', 'ChevronLeft', 'FileText', 'Globe', 'Heart', 'Images', 'Lock', 'LockKeyhole',
    'MessageCircle', 'MoreHorizontal', 'Repeat2', 'Share', 'Share2', 'ShoppingBag', 'Wand2', 'X',
  ].map((name) => [name, icon(name)]));
});
// What the card hands its shell is the subject: the shell itself draws nothing here.
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
vi.mock('@/components/remix-credit-line', () => ({ RemixCreditLine: () => null }));
vi.mock('@/components/save-heart', () => ({ SaveHeart: () => null }));
vi.mock('@/components/showcase-media-preview', () => ({ ShowcaseMediaPreview: () => null }));

import { HomeFeedCardView } from '../components/home-feed-card';
import { ShowcaseMediaPreview } from '../components/showcase-media-preview';

afterEach(() => {
  shell.props = null;
});

const photo: ShowcaseMediaItem = {
  id: 'post-1:media',
  url: 'https://cdn.example.com/post-1.jpg',
  previewUrl: 'https://cdn.example.com/post-1.preview.webp',
  previewThumbhash: null,
  previewCacheKey: 'post-1',
  gridReady: true,
  mediaKind: 'image',
  contentType: 'image/jpeg',
  originalName: null,
  width: 800,
  height: 1000,
  durationSeconds: null,
  sortOrder: 0,
};

function mediaCard(): HomeFeedCard {
  const item = {
    id: 'post-1',
    mediaUrl: photo.url,
    mediaKind: 'image',
    mediaItems: [photo],
    model: 'manual',
    title: 'Above the clouds',
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-25T08:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
  } as unknown as ShowcaseFeedItem;
  return {
    id: 'post-1',
    item,
    previewKind: 'media',
    mediaUrl: photo.url,
    mediaKind: 'image',
    aspectRatio: 0.8,
    bodyText: null,
    title: 'Above the clouds',
    accent: 'image',
    categoryLabel: 'Image',
    creatorAvatar: null,
    creatorLabel: '@luna',
    creatorName: 'Luna',
    timeLabel: '2h',
    isSaved: false,
    saveLabel: 'Save',
    commentLabel: '0',
    remixAccess: null,
    recipeChip: null,
  } as unknown as HomeFeedCard;
}

/** The picture the card hands its shell, as the shell would draw it. */
function cardPicture() {
  const media = shell.props?.media as React.ReactElement<{ children: React.ReactElement<Record<string, unknown>> }>;
  const picture = media.props.children;
  expect(picture.type).toBe(ShowcaseMediaPreview);
  return picture.props;
}

describe("a Home card's picture that would not load", () => {
  // Without this hand-off Home never hears of the failure, and a gone post's
  // card sits on "Preview unavailable" with a Retry that cannot succeed.
  it('reaches Home, with the media that failed', () => {
    const onMediaUnavailable = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <HomeFeedCardView
          card={mediaCard()}
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
          onMediaUnavailable={onMediaUnavailable}
        />,
      );
    });

    (cardPicture().onMediaUnavailable as (media: ShowcaseMediaItem) => void)(photo);

    expect(onMediaUnavailable).toHaveBeenCalledWith(photo);
    renderer.act(() => tree.unmount());
  });
});
