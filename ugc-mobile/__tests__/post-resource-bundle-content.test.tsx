import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { PostResourceBundleResources, PostResourceItem, ShowcaseMediaItem } from '../lib/types';

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
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  Check: (props: MockProps) => React.createElement('check-icon', props),
  Copy: (props: MockProps) => React.createElement('copy-icon', props),
  Download: (props: MockProps) => React.createElement('download-icon', props),
  ExternalLink: (props: MockProps) => React.createElement('external-link-icon', props),
  FileText: (props: MockProps) => React.createElement('file-icon', props),
  Link2: (props: MockProps) => React.createElement('link-icon', props),
  Lock: (props: MockProps) => React.createElement('lock-icon', props),
  Repeat2: (props: MockProps) => React.createElement('repeat-icon', props),
  Settings2: (props: MockProps) => React.createElement('settings-icon', props),
}));

vi.mock('@/components/feed-media-frame', () => ({
  FeedMediaFrame: (props: MockProps) => React.createElement('feed-media-frame', props),
}));

vi.mock('@/components/post-resource-references', () => ({
  getReferenceResourceItems: (items: PostResourceItem[] | undefined) => (items ?? []).filter((item) => (
    item.type === 'reference_image'
    || item.type === 'reference_video'
    || item.type === 'reference_audio'
    || (item.type === 'source_file' && Boolean(item.contentType?.match(/^(image|video|audio)\//)))
  )),
  PostResourceReferences: ({ items }: { items: PostResourceItem[] }) => React.createElement(
    'references',
    {},
    items.map((item) => React.createElement('text', { key: item.id ?? item.title }, item.title))
  ),
}));

import { PostResourceBundleContent } from '../components/post-resource-bundle-content';

function item(overrides: Partial<PostResourceItem> & Pick<PostResourceItem, 'title' | 'type'>): PostResourceItem {
  return {
    id: overrides.id ?? `${overrides.type}-${overrides.title.replace(/\s+/g, '-').toLowerCase()}`,
    scope: overrides.scope ?? { kind: 'all' },
    role: 'primary',
    sectionId: null,
    description: null,
    textContent: null,
    externalUrl: null,
    storagePath: null,
    contentType: null,
    sizeBytes: null,
    workflowSnapshot: null,
    sortOrder: 0,
    isPrimary: false,
    remixUse: 'none',
    ...overrides,
  };
}

function media(id: string, mediaKey: string): ShowcaseMediaItem {
  return {
    id,
    mediaKey,
    url: `https://cdn.example.com/${id}.jpg`,
    mediaKind: 'image',
    contentType: 'image/jpeg',
    originalName: `${id}.jpg`,
    width: 800,
    height: 1000,
    durationSeconds: null,
    sortOrder: Number(id.replace(/\D/g, '')) || 0,
  };
}

function textValues(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text')
    .flatMap((node) => typeof node.props.children === 'string' ? [node.props.children] : []);
}

function pressable(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label)[0];
}

function renderContent(element: React.ReactElement) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree!;
}

describe('PostResourceBundleContent', () => {
  it('shows only explicit public card previews while a package is locked', () => {
    const tree = renderContent(
      <PostResourceBundleContent
        lockedPreview={{
          cardPreviews: [{
            sectionId: 'remix-kit',
            publicTitle: 'Cinematic remix kit',
            resourceType: 'remix_link',
            scope: { kind: 'all' },
            itemCount: 2,
            hasRemix: true,
          }],
          itemPreviews: [{
            type: 'remix_link',
            title: 'Private client remix URL',
            role: 'primary',
            remixUse: 'none',
          }],
          promptPreview: 'Private prompt preview',
          notesPreview: 'Private notes preview',
        }}
        resources={null}
      />
    );

    const values = textValues(tree);
    expect(values).toContain('Cinematic remix kit');
    expect(values).toContain('Remix included');
    expect(values).not.toContain('Private client remix URL');
    expect(values).not.toContain('Private prompt preview');
    expect(values).not.toContain('Private notes preview');
  });

  // The server has already redacted these to "File 1" / "Link 1". Showing them
  // is how a locked package communicates its size, which is what web does.
  it('shows redacted attachment rows while a package is locked', () => {
    const tree = renderContent(
      <PostResourceBundleContent
        lockedPreview={{
          cardPreviews: [],
          itemPreviews: [],
          attachmentPreviews: [
            { kind: 'file', label: 'File 1' },
            { kind: 'link', label: 'Link 1' },
          ],
        }}
        resources={null}
      />
    );

    const values = textValues(tree);
    expect(values).toContain('File 1');
    expect(values).toContain('Link 1');
    expect(values).not.toContain('Resource details stay private until this package is unlocked.');
  });

  it('renders the section description a creator wrote after unlock', () => {
    const tree = renderContent(
      <PostResourceBundleContent
        resources={{
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          workflowSnapshot: null,
          attachments: [],
          allowRemix: false,
          sections: [{
            id: 'hook',
            title: 'Hook',
            publicTitle: 'Hook',
            kind: 'global',
            description: 'Why this opening works.',
            sortOrder: 0,
          }],
          items: [{
            id: 'hook-item-1',
            sectionId: 'hook',
            type: 'prompt',
            role: 'primary',
            title: 'Hook prompt',
            textContent: 'Open on the before state.',
            remixUse: 'text_template',
            scope: { kind: 'all' },
            sortOrder: 0,
            isPrimary: true,
          }],
        } as never}
      />
    );

    expect(textValues(tree)).toContain('Why this opening works.');
  });

  it('renders and opens every typed resource after unlock', async () => {
    const onCopy = vi.fn();
    const onOpenFile = vi.fn();
    const onOpenUrl = vi.fn();
    const resources: PostResourceBundleResources = {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      sections: [
        { id: 'recipe', title: 'Launch recipe', kind: 'asset_group', description: null, sortOrder: 0, resourceType: 'prompt', scope: { kind: 'all' } },
        { id: 'links', title: 'Project links', kind: 'asset_group', description: null, sortOrder: 1, resourceType: 'workflow', scope: { kind: 'all' } },
        { id: 'references', title: 'Reference media', kind: 'asset_group', description: null, sortOrder: 2, resourceType: 'reference_video', scope: { kind: 'all' } },
      ],
      items: [
        item({ id: 'prompt', type: 'prompt', title: 'Hero prompt', sectionId: 'recipe', textContent: 'A precise campaign prompt.', sortOrder: 0 }),
        item({ id: 'settings', type: 'settings', title: 'Model settings', sectionId: 'recipe', textContent: 'CFG 7, steps 32', sortOrder: 1 }),
        item({ id: 'workflow', type: 'workflow', title: 'Comfy project', sectionId: 'links', externalUrl: 'https://example.com/workflow', sortOrder: 2 }),
        item({ id: 'guide', type: 'note', title: 'Creator guide', sectionId: 'links', textContent: 'Start with the workflow.', sortOrder: 3 }),
        item({ id: 'source', type: 'source_file', title: 'Layered source', sectionId: 'links', storagePath: 'user/source.zip', contentType: 'application/zip', sortOrder: 4 }),
        item({ id: 'external', type: 'external_link', title: 'Font pack', sectionId: 'links', externalUrl: 'https://example.com/fonts', sortOrder: 5 }),
        item({ id: 'remix', type: 'remix_link', title: 'Open remix project', sectionId: 'links', externalUrl: 'https://example.com/remix', sortOrder: 6 }),
        item({ id: 'reference-video', type: 'reference_video', title: 'Motion reference', sectionId: 'references', storagePath: 'user/reference.mp4', contentType: 'video/mp4', sortOrder: 7 }),
      ],
    };
    const tree = renderContent(
      <PostResourceBundleContent
        onCopy={onCopy}
        onOpenFile={onOpenFile}
        onOpenUrl={onOpenUrl}
        resolveFileUrl={async () => 'https://signed.example.com/reference'}
        resources={resources}
      />
    );

    const values = textValues(tree);
    expect(values).toEqual(expect.arrayContaining([
      'Hero prompt',
      'A precise campaign prompt.',
      'Model settings',
      'Comfy project',
      'Creator guide',
      'Layered source',
      'Font pack',
      'Open remix project',
      'Motion reference',
    ]));

    await renderer.act(async () => {
      await pressable(tree, 'Copy prompt').props.onPress();
      await pressable(tree, 'Open workflow').props.onPress();
      await pressable(tree, 'Open remix').props.onPress();
      await pressable(tree, 'Open file').props.onPress();
    });
    expect(onCopy).toHaveBeenCalledWith('A precise campaign prompt.');
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/workflow');
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com/remix');
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ storagePath: 'user/source.zip' }));
  });

  it('filters shared and media-scoped public cards by selected output', () => {
    const tree = renderContent(
      <PostResourceBundleContent
        lockedPreview={{
          cardPreviews: [
            { sectionId: 'all', publicTitle: 'Shared guide', resourceType: 'note', scope: { kind: 'all' }, itemCount: 1, hasRemix: false },
            { sectionId: 'first', publicTitle: 'First image prompt', resourceType: 'prompt', scope: { kind: 'media', mediaKeys: ['media-one'] }, itemCount: 1, hasRemix: false },
            { sectionId: 'second', publicTitle: 'Second image prompt', resourceType: 'prompt', scope: { kind: 'media', mediaKeys: ['media-two'] }, itemCount: 1, hasRemix: false },
          ],
        }}
        mediaItems={[media('1', 'media-one'), media('2', 'media-two')]}
        resources={null}
      />
    );

    renderer.act(() => {
      pressable(tree, 'Resources for output 2').props.onPress();
    });
    const values = textValues(tree);
    expect(values).toContain('Shared guide');
    expect(values).toContain('Second image prompt');
    expect(values).not.toContain('First image prompt');
  });

  it('explains when a locked output has no matching resource cards', () => {
    const tree = renderContent(
      <PostResourceBundleContent
        lockedPreview={{
          cardPreviews: [
            { sectionId: 'second', publicTitle: 'Second image prompt', resourceType: 'prompt', scope: { kind: 'media', mediaKeys: ['media-two'] }, itemCount: 1, hasRemix: false },
          ],
        }}
        mediaItems={[media('1', 'media-one'), media('2', 'media-two')]}
        resources={null}
      />
    );

    renderer.act(() => {
      pressable(tree, 'Resources for output 1').props.onPress();
    });

    const values = textValues(tree);
    expect(values).toContain('No resources apply to this output.');
    expect(values).not.toContain('Second image prompt');
  });

  it('filters unlocked library resources with the full proof-media array', () => {
    const tree = renderContent(
      <PostResourceBundleContent
        mediaItems={[media('1', 'media-one'), media('2', 'media-two')]}
        resources={{
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          workflowSnapshot: null,
          attachments: [],
          allowRemix: false,
          sections: [
            { id: 'first', title: 'First output', kind: 'asset_group', description: null, sortOrder: 0, resourceType: 'prompt', scope: { kind: 'media', mediaKeys: ['media-one'] } },
            { id: 'second', title: 'Second output', kind: 'asset_group', description: null, sortOrder: 1, resourceType: 'prompt', scope: { kind: 'media', mediaKeys: ['media-two'] } },
          ],
          items: [
            item({ id: 'first-prompt', type: 'prompt', title: 'First prompt', sectionId: 'first', textContent: 'First', scope: { kind: 'all' } }),
            item({ id: 'second-prompt', type: 'prompt', title: 'Second prompt', sectionId: 'second', textContent: 'Second', scope: { kind: 'all' } }),
          ],
        }}
      />
    );

    renderer.act(() => {
      pressable(tree, 'Resources for output 2').props.onPress();
    });

    const values = textValues(tree);
    expect(values).toContain('Second output');
    expect(values).toContain('Second prompt');
    expect(values).not.toContain('First output');
    expect(values).not.toContain('First prompt');
  });

  it('clears a stale output selection when a purchased revision has different media keys', () => {
    const resourcesFor = (sectionId: string, mediaKey: string, title: string): PostResourceBundleResources => ({
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      sections: [{
        id: sectionId,
        title,
        kind: 'asset_group',
        description: null,
        sortOrder: 0,
        resourceType: 'prompt',
        scope: { kind: 'media', mediaKeys: [mediaKey] },
      }],
      items: [item({
        id: `${sectionId}-prompt`,
        type: 'prompt',
        title: `${title} prompt`,
        sectionId,
        textContent: title,
        scope: { kind: 'all' },
      })],
    });
    const latestMedia = [media('1', 'latest-one'), media('2', 'latest-two')];
    const purchasedMedia = [media('3', 'purchased-one'), media('4', 'purchased-two')];
    const tree = renderContent(
      <PostResourceBundleContent
        mediaItems={latestMedia}
        resources={resourcesFor('latest', 'latest-two', 'Latest output')}
      />
    );

    renderer.act(() => {
      pressable(tree, 'Resources for output 2').props.onPress();
    });
    expect(textValues(tree)).toContain('Latest output');

    renderer.act(() => {
      tree.update(
        <PostResourceBundleContent
          mediaItems={purchasedMedia}
          resources={resourcesFor('purchased', 'purchased-one', 'Purchased output')}
        />
      );
    });

    expect(textValues(tree)).toContain('Purchased output');
    expect(textValues(tree)).not.toContain('No resources apply to this output.');
  });

  it('shows a saved generation setup as settings and copies the raw note', async () => {
    const onCopy = vi.fn();
    const note = 'Saved generation setup\nModel: Nano Banana 2.0\nAspect ratio: 9:16\nResolution: 1K';
    const resources: PostResourceBundleResources = {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      sections: [
        { id: 'notes', title: 'Guide or notes', kind: 'asset_group', description: null, sortOrder: 0, resourceType: 'note', scope: { kind: 'all' } },
      ],
      items: [
        item({ id: 'setup', type: 'note', title: 'Notes', sectionId: 'notes', textContent: note, sortOrder: 0 }),
      ],
    };
    const tree = renderContent(<PostResourceBundleContent onCopy={onCopy} resources={resources} />);

    const values = textValues(tree);
    expect(values).toEqual(expect.arrayContaining(['Generation setup', 'Model', 'Nano Banana 2.0', 'Aspect ratio', '9:16', 'Resolution', '1K']));
    expect(values).not.toContain('Guide or notes');
    expect(values).not.toContain('Notes');
    expect(values).not.toContain(note);

    await renderer.act(async () => {
      await pressable(tree, 'Copy').props.onPress();
    });
    expect(onCopy).toHaveBeenCalledWith(note);
  });

  it('keeps hand-written notes as prose under the group the creator named', () => {
    const resources: PostResourceBundleResources = {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      sections: [
        { id: 'notes', title: 'Why this works', kind: 'asset_group', description: null, sortOrder: 0, resourceType: 'note', scope: { kind: 'all' } },
      ],
      items: [
        item({ id: 'guide', type: 'note', title: 'Notes', sectionId: 'notes', textContent: 'Open with tension, then pay it off.', sortOrder: 0 }),
      ],
    };
    const tree = renderContent(<PostResourceBundleContent resources={resources} />);

    const values = textValues(tree);
    expect(values).toEqual(expect.arrayContaining(['Why this works', 'Guide or notes', 'Open with tension, then pay it off.']));
    expect(values).not.toContain('Generation setup');
  });

  it('prints a lone generic item title once, not over its own group', () => {
    const resources: PostResourceBundleResources = {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      sections: [
        { id: 'prompt', title: 'Prompt or script', kind: 'asset_group', description: null, sortOrder: 0, resourceType: 'prompt', scope: { kind: 'all' } },
      ],
      items: [
        item({ id: 'prompt', type: 'prompt', title: 'Prompt', sectionId: 'prompt', textContent: 'A glossy product photo', sortOrder: 0 }),
      ],
    };
    const tree = renderContent(<PostResourceBundleContent resources={resources} />);

    const values = textValues(tree);
    expect(values.filter((value) => value === 'Prompt or script')).toHaveLength(1);
    expect(values).not.toContain('Prompt');
    expect(values).not.toContain('1 item');
    expect(values).toContain('A glossy product photo');
  });
});
