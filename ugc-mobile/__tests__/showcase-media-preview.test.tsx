import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: vi.fn(async () => false),
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  FlatList: ({ data, renderItem, ...props }: MockProps & {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
  }) => React.createElement(
    'flat-list',
    props,
    data?.map((entry, index) => renderItem?.({ item: entry, index }))
  ),
  Platform: { OS: 'ios' },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  Images: (props: MockProps) => React.createElement('images-icon', props),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('expo-image', props),
}));

vi.mock('@/components/feed-media-frame', () => ({
  FeedMediaFrame: (props: MockProps) => React.createElement('feed-media-frame', props),
}));

vi.mock('@/components/feed-video-preview', () => ({
  FeedVideoPreview: (props: MockProps) => React.createElement('feed-video-preview', props),
}));

import {
  ShowcaseMediaPreview,
} from '../components/showcase-media-preview';
import { getShowcasePreviewMediaItems } from '../lib/showcase-media';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '../lib/types';

function media(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
  return {
    id: 'media-1',
    url: 'https://cdn.example.com/original.jpg',
    previewUrl: null,
    previewThumbhash: null,
    previewCacheKey: 'preview-key',
    gridReady: true,
    mediaKind: 'image',
    contentType: 'image/jpeg',
    originalName: 'original.jpg',
    width: 1024,
    height: 1024,
    durationSeconds: null,
    sortOrder: 0,
    ...overrides,
  };
}

function item(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://cdn.example.com/original.jpg',
    mediaKind: 'image',
    mediaItems: [media()],
    model: 'manual',
    title: 'Creator post',
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

function renderPreview(element: React.ReactElement) {
  let tree: renderer.ReactTestRenderer | undefined;

  renderer.act(() => {
    tree = renderer.create(element);
  });

  return tree!;
}

function findAllByNodeType(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.findAll((node) => String(node.type) === type);
}

describe('ShowcaseMediaPreview', () => {
  it('renders a pending plate without fetching the original image when a preview is unavailable', () => {
    const tree = renderPreview(
      <ShowcaseMediaPreview
        accent="#60a5fa"
        height={180}
        mediaItems={[media({ previewUrl: null, previewStatus: 'processing' })]}
        radius={12}
        recyclingKey="creator-profile:post-1"
        width={160}
      />
    );

    expect(findAllByNodeType(tree, 'feed-media-frame')).toHaveLength(0);
    expect(findAllByNodeType(tree, 'images-icon')).toHaveLength(1);
  });

  it('uses a thumbhash for a pending image when one is available', () => {
    const tree = renderPreview(
      <ShowcaseMediaPreview
        accent="#60a5fa"
        height={180}
        mediaItems={[media({
          previewUrl: null,
          previewStatus: 'processing',
          previewThumbhash: 'thumbhash-value',
        })]}
        radius={12}
        recyclingKey="creator-profile:post-1"
        width={160}
      />
    );

    const [placeholder] = findAllByNodeType(tree, 'expo-image');
    expect(placeholder.props.placeholder).toEqual({ thumbhash: 'thumbhash-value' });
    expect(findAllByNodeType(tree, 'feed-media-frame')).toHaveLength(0);
    expect(findAllByNodeType(tree, 'images-icon')).toHaveLength(0);
  });

  it('does not fetch the original when preview generation has failed', () => {
    const tree = renderPreview(
      <ShowcaseMediaPreview
        accent="#60a5fa"
        height={180}
        mediaItems={[media({ previewUrl: null, previewStatus: 'failed' })]}
        radius={12}
        recyclingKey="creator-profile:post-1"
        width={160}
      />
    );

    expect(findAllByNodeType(tree, 'feed-media-frame')).toHaveLength(0);
    expect(findAllByNodeType(tree, 'images-icon')).toHaveLength(1);
  });

  it('falls back to the original image when a generated preview fails', () => {
    const tree = renderPreview(
      <ShowcaseMediaPreview
        accent="#60a5fa"
        height={180}
        mediaItems={[media({ previewUrl: 'https://cdn.example.com/preview.webp' })]}
        radius={12}
        recyclingKey="creator-profile:post-1"
        width={160}
      />
    );

    expect(findAllByNodeType(tree, 'feed-media-frame')[0].props.url).toBe('https://cdn.example.com/preview.webp');
    renderer.act(() => {
      findAllByNodeType(tree, 'feed-media-frame')[0].props.onImageError();
    });
    expect(findAllByNodeType(tree, 'feed-media-frame')[0].props.url).toBe('https://cdn.example.com/original.jpg');
  });

  it('uses the feed video preview with the supplied poster', () => {
    const tree = renderPreview(
      <ShowcaseMediaPreview
        accent="#fb7185"
        height={180}
        mediaItems={[media({
          id: 'video-1',
          url: 'https://cdn.example.com/original.mp4',
          previewUrl: 'https://cdn.example.com/poster.webp',
          mediaKind: 'video',
          contentType: 'video/mp4',
        })]}
        radius={12}
        recyclingKey="creator-profile:video-1"
        videoActivation="never"
        videoBackdrop="none"
        videoContentFit="cover"
        width={160}
      />
    );

    const [video] = findAllByNodeType(tree, 'feed-video-preview');
    expect(video.props.url).toBe('https://cdn.example.com/original.mp4');
    expect(video.props.previewUrl).toBe('https://cdn.example.com/poster.webp');
    expect(video.props.active).toBe(false);
    expect(video.props.videoBackdrop).toBe('none');
    expect(video.props.videoContentFit).toBe('cover');
  });

  it('requests a first frame for a video when no poster exists', () => {
    const tree = renderPreview(
      <ShowcaseMediaPreview
        accent="#fb7185"
        height={180}
        mediaItems={[media({
          id: 'video-without-poster',
          url: 'https://cdn.example.com/original.mp4',
          mediaKind: 'video',
          contentType: 'video/mp4',
        })]}
        radius={12}
        recyclingKey="creator-profile:video-without-poster"
        videoActivation="when-poster-missing"
        width={160}
      />
    );

    const [video] = findAllByNodeType(tree, 'feed-video-preview');
    expect(video.props.active).toBe(true);
  });

  it('keeps every media item available in a swipeable preview', () => {
    const tree = renderPreview(
      <ShowcaseMediaPreview
        accent="#60a5fa"
        height={180}
        mediaItems={[
          media({ id: 'image-1', previewUrl: 'https://cdn.example.com/image-1.preview.webp' }),
          media({ id: 'video-1', mediaKind: 'video', url: 'https://cdn.example.com/original.mp4' }),
        ]}
        radius={12}
        recyclingKey="creator-profile:post-1"
        width={160}
      />
    );

    expect(findAllByNodeType(tree, 'feed-media-frame')).toHaveLength(1);
    expect(findAllByNodeType(tree, 'feed-video-preview')).toHaveLength(1);
    expect(findAllByNodeType(tree, 'flat-list')).toHaveLength(1);
    const [list] = findAllByNodeType(tree, 'flat-list');
    expect(list.props.initialNumToRender).toBe(1);
    expect(list.props.maxToRenderPerBatch).toBe(2);
    expect(list.props.windowSize).toBe(3);
  });

  /**
   * The feed suspends its own vertical scrolling while a card's media is swiped
   * sideways, so these reports are a lock on the whole list. Gestures: "if you
   * don't clearly communicate why a gesture doesn't work, people might think
   * your app has frozen" — and a lock that is taken and never given back is
   * exactly that, with the feed unable to scroll at all.
   */
  describe('reporting a sideways drag to the feed', () => {
    function renderCarousel(onScrollToggle: (scrolling: boolean) => void) {
      const tree = renderPreview(
        <ShowcaseMediaPreview
          accent="#60a5fa"
          height={180}
          mediaItems={[
            media({ id: 'image-1', previewUrl: 'https://cdn.example.com/image-1.preview.webp' }),
            media({ id: 'image-2', previewUrl: 'https://cdn.example.com/image-2.preview.webp' }),
          ]}
          onScrollToggle={onScrollToggle}
          radius={12}
          recyclingKey="showcase:post-1"
          width={160}
        />
      );
      const [list] = findAllByNodeType(tree, 'flat-list');
      return { tree, list };
    }

    it('reports one release for a drag that ends and then runs out of momentum', () => {
      const onScrollToggle = vi.fn();
      const { list } = renderCarousel(onScrollToggle);

      renderer.act(() => {
        list.props.onScrollBeginDrag();
        list.props.onScrollEndDrag();
        list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 160 } } });
      });

      // Two `false`s from one drag would take the feed's counter below zero.
      expect(onScrollToggle.mock.calls.map(([scrolling]) => scrolling)).toEqual([true, false]);
    });

    it('releases the lock when the cell is torn down mid-drag', () => {
      const onScrollToggle = vi.fn();
      const { tree, list } = renderCarousel(onScrollToggle);

      renderer.act(() => { list.props.onScrollBeginDrag(); });
      expect(onScrollToggle).toHaveBeenLastCalledWith(true);

      renderer.act(() => { tree.unmount(); });

      expect(onScrollToggle).toHaveBeenLastCalledWith(false);
    });
  });

  it('does not disguise a legacy post-level source URL as an image preview', () => {
    const previews = getShowcasePreviewMediaItems(item({ mediaItems: undefined }));

    expect(previews).toHaveLength(1);
    expect(previews[0].mediaKind).toBe('image');
    expect(previews[0].url).toBe('https://cdn.example.com/original.jpg');
    expect(previews[0].previewUrl).toBeNull();
  });
});
