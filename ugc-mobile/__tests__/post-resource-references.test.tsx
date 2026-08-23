import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { PostResourceItem } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', { ...props, style: resolvePressableStyle(style) }, children),
  ScrollView: ({ children, ...props }: MockProps) =>
    React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  ExternalLink: (props: MockProps) => React.createElement('external-link-icon', props),
  FileText: (props: MockProps) => React.createElement('file-text-icon', props),
  ImageIcon: (props: MockProps) => React.createElement('image-icon', props),
}));

vi.mock('@/components/feed-media-frame', () => ({
  FeedMediaFrame: (props: MockProps) => React.createElement('feed-media-frame', props),
}));

vi.mock('@/components/media-lightbox', () => ({
  MediaLightbox: (props: MockProps) => React.createElement('media-lightbox', props),
}));

import { PostResourceReferences } from '../components/post-resource-references';

const referenceImage: PostResourceItem = {
  type: 'reference_image',
  role: 'character_reference',
  sectionId: null,
  title: '@alisa',
  description: 'Character reference',
  textContent: null,
  externalUrl: null,
  storagePath: 'references/alisa.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 120_000,
  workflowSnapshot: null,
  sortOrder: 0,
  isPrimary: true,
  remixUse: 'reference_only',
};

const promptItem: PostResourceItem = {
  ...referenceImage,
  type: 'prompt',
  role: 'primary',
  title: 'Prompt',
  storagePath: null,
  contentType: null,
  textContent: 'Create a portrait',
  remixUse: 'text_template',
};

describe('PostResourceReferences', () => {
  it('preloads and renders an unlocked reference image with contained media', async () => {
    const resolveFileUrl = vi.fn(async () => 'https://cdn.example.com/alisa.jpg');
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[promptItem, referenceImage]}
          onOpenUrl={vi.fn()}
          resolveFileUrl={resolveFileUrl}
        />
      );
    });

    expect(resolveFileUrl).toHaveBeenCalledWith('references/alisa.jpg');
    expect(tree!.root.findByProps({ children: 'References' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: '@alisa' })).toBeTruthy();

    const preview = tree!.root.find((node) => String(node.type) === 'feed-media-frame');
    expect(preview.props.kind).toBe('image');
    expect(preview.props.url).toBe('https://cdn.example.com/alisa.jpg');
  });

  it('shows a reference image in the app instead of a browser tab', async () => {
    const onOpenUrl = vi.fn(async () => undefined);
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[referenceImage]}
          onOpenUrl={onOpenUrl}
          resolveFileUrl={async () => 'https://cdn.example.com/alisa.jpg'}
        />
      );
    });

    const lightbox = () => tree!.root.findByType('media-lightbox' as never);
    expect(lightbox().props.activeIndex).toBeNull();

    const reference = tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' });
    await renderer.act(async () => {
      await reference.props.onPress();
    });

    expect(onOpenUrl).not.toHaveBeenCalled();
    expect(lightbox().props.activeIndex).toBe(0);
    expect(lightbox().props.items).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example.com/alisa.jpg',
        mediaKind: 'image',
        label: '@alisa',
        caption: 'Character reference',
      }),
    ]);

    await renderer.act(async () => {
      lightbox().props.onClose();
    });
    expect(lightbox().props.activeIndex).toBeNull();
  });

  it('plays a reference video in the app but still hands audio to the browser', async () => {
    const onOpenUrl = vi.fn(async () => undefined);
    const videoReference: PostResourceItem = {
      ...referenceImage,
      id: 'video-reference',
      type: 'reference_video',
      title: 'Camera movement',
      storagePath: 'references/camera.mp4',
      contentType: 'video/mp4',
    };
    const audioReference: PostResourceItem = {
      ...referenceImage,
      id: 'audio-reference',
      type: 'reference_audio',
      title: 'Timing track',
      storagePath: 'references/timing.mp3',
      contentType: 'audio/mpeg',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[videoReference, audioReference]}
          onOpenUrl={onOpenUrl}
          resolveFileUrl={async (path) => `https://cdn.example.com/${path}`}
        />
      );
    });

    const lightbox = () => tree!.root.findByType('media-lightbox' as never);
    expect(lightbox().props.items.map((item: { mediaKind: string }) => item.mediaKind)).toEqual(['video']);

    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Open reference Camera movement' }).props.onPress();
    });
    expect(lightbox().props.activeIndex).toBe(0);
    expect(onOpenUrl).not.toHaveBeenCalled();

    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Open reference Timing track' }).props.onPress();
    });
    expect(onOpenUrl).toHaveBeenCalledWith('https://cdn.example.com/references/timing.mp3');
  });

  it('keeps an external link as a link', async () => {
    const onOpenUrl = vi.fn(async () => undefined);
    const linkedImage: PostResourceItem = {
      ...referenceImage,
      id: 'linked',
      title: 'Mood board',
      storagePath: null,
      externalUrl: 'https://example.com/board',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences items={[linkedImage]} onOpenUrl={onOpenUrl} resolveFileUrl={vi.fn()} />
      );
    });

    await renderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Open reference Mood board' }).props.onPress();
    });
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/board');
    expect(tree!.root.findByType('media-lightbox' as never).props.items).toEqual([]);
  });

  it('renders openable non-image reference media without an inline preview', async () => {
    const sourceVideo: PostResourceItem = {
      ...referenceImage,
      type: 'source_file',
      title: 'Source clip',
      storagePath: 'references/source.mp4',
      contentType: 'video/mp4',
      role: 'before_input',
      remixUse: 'import_source',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[sourceVideo]}
          onOpenUrl={vi.fn()}
          resolveFileUrl={async () => 'https://cdn.example.com/source.mp4'}
        />
      );
    });

    expect(tree!.root.findByProps({ children: 'Source clip' })).toBeTruthy();
    expect(tree!.root.findAll((node) => String(node.type) === 'feed-media-frame')).toHaveLength(0);
    expect(tree!.root.findByProps({ children: 'Open video' })).toBeTruthy();
  });

  it('includes explicit video and audio reference item types', async () => {
    const videoReference: PostResourceItem = {
      ...referenceImage,
      id: 'video-reference',
      type: 'reference_video',
      title: 'Camera movement',
      storagePath: 'references/camera.mp4',
      contentType: 'video/mp4',
    };
    const audioReference: PostResourceItem = {
      ...referenceImage,
      id: 'audio-reference',
      type: 'reference_audio',
      title: 'Timing track',
      storagePath: 'references/timing.mp3',
      contentType: 'audio/mpeg',
    };
    let tree: renderer.ReactTestRenderer | undefined;

    await renderer.act(async () => {
      tree = renderer.create(
        <PostResourceReferences
          items={[videoReference, audioReference]}
          onOpenUrl={vi.fn()}
          resolveFileUrl={async (path) => `https://cdn.example.com/${path}`}
        />
      );
    });

    expect(tree!.root.findByProps({ children: 'Camera movement' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'Timing track' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'Open video' })).toBeTruthy();
    expect(tree!.root.findByProps({ children: 'Open audio' })).toBeTruthy();
  });

  it('renders nothing when structured reference items are unavailable', () => {
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <PostResourceReferences
          items={undefined}
          onOpenUrl={vi.fn()}
          resolveFileUrl={vi.fn()}
        />
      );
    });

    expect(tree!.toJSON()).toBeNull();
  });
});
