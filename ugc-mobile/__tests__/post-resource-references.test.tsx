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

  it('opens a reference using its prefetched signed URL', async () => {
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

    const reference = tree!.root.findByProps({ accessibilityLabel: 'Open reference @alisa' });
    await renderer.act(async () => {
      await reference.props.onPress();
    });

    expect(onOpenUrl).toHaveBeenCalledWith('https://cdn.example.com/alisa.jpg');
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
    expect(tree!.root.findByProps({ children: 'Open media' })).toBeTruthy();
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
