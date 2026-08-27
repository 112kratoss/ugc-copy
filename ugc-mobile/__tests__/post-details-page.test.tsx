import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';

type MockProps = { children?: React.ReactNode; label?: string } & Record<string, unknown>;

const { bundleContentProps, queryState, mutationState } = vi.hoisted(() => ({
  bundleContentProps: vi.fn(),
  queryState: { current: { data: undefined as unknown, isError: false, error: null as unknown, refetch: vi.fn() } },
  mutationState: { mutate: vi.fn(), isPending: false, error: null as unknown },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return {
    ArrowLeft: icon('arrowleft'),
    X: icon('x'),
    ChevronLeft: icon('chevron-left'),
    Copy: icon('copy'),
    FileText: icon('file'),
    Lock: icon('lock'),
    MessageCircle: icon('message'),
    MoreVertical: icon('more'),
    Repeat2: icon('repeat'),
    // Both share dialects: ShareGlyph picks one per platform.
    Share: icon('share'),
    Share2: icon('share'),
  };
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryState.current,
  useMutation: () => mutationState,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'viewer-1' }, api: {} }),
}));

vi.mock('@/components/save-heart', () => ({
  SaveHeart: (props: MockProps) => React.createElement('save-heart', props),
}));

vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('avatar', props),
  Pill: ({ label, ...props }: MockProps) => React.createElement('text', props, label),
}));

vi.mock('@/components/post-resource-bundle-content', () => ({
  PostResourceBundleContent: (props: unknown) => {
    bundleContentProps(props);
    return null;
  },
  ResourceAction: ({ label, ...props }: MockProps) => React.createElement('pressable', { accessibilityLabel: label, ...props }, label),
}));

import { PostDetailsPage } from '@/components/post-details-page';

function showcaseItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-1',
    source: 'showcase-feed',
    sourceType: 'showcase',
    title: 'Minnal Murali',
    displayText: 'Minnal Murali',
    mediaItems: [],
    creatorLabel: '@batman',
    creatorUsername: 'batman',
    createdAt: '2026-08-23T09:00:00.000Z',
    saveCount: 0,
    commentCount: 2,
    canComment: true,
    canSave: true,
    canShare: true,
    isSaved: false,
    showcasePostId: 'post-1',
    ownerPostId: null,
    availableActions: ['save', 'comment', 'share', 'recreate', 'view-details'],
    details: {
      title: 'Minnal Murali',
      prompt: '',
      body: '',
      categoryLabel: 'Image',
      sourceLabel: 'Showcase',
      creatorLabel: '@batman',
      creatorAvatar: null,
      saveCount: 0,
      remixCount: 0,
      unlock: {
        resourceId: 'asset-1',
        postId: 'post-1',
        title: 'Minnal Murali',
        accessMode: 'free',
        priceLabel: 'Free',
        previewText: null,
        resourceKinds: ['prompt', 'notes', 'remix'],
        allowRemix: true,
      },
    },
    ...overrides,
  } as unknown as ImmersivePreviewItem;
}

function render(element: React.ReactElement) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree!;
}

function textValues(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text')
    .flatMap((node) => typeof node.props.children === 'string' ? [node.props.children] : []);
}

function pressable(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label)[0];
}

function page(props: Partial<React.ComponentProps<typeof PostDetailsPage>> = {}) {
  return (
    <PostDetailsPage
      active
      bottomInset={0}
      height={800}
      item={showcaseItem()}
      onRecreate={vi.fn()}
      onSave={vi.fn()}
      onShare={vi.fn()}
      saveLoading={false}
      topInset={0}
      width={400}
      {...props}
    />
  );
}

describe('PostDetailsPage', () => {
  beforeEach(() => {
    bundleContentProps.mockClear();
    queryState.current = { data: undefined, isError: false, error: null, refetch: vi.fn() };
  });

  it('shows no unlock button and no locked copy while the bundle is still loading', () => {
    const tree = render(page());

    const values = textValues(tree);
    expect(values).toContain("Creator's resources");
    expect(values).toContain('Free');
    expect(values).toContain('Prompt');
    expect(pressable(tree, 'Get resources — Free')).toBeUndefined();
    expect(bundleContentProps).not.toHaveBeenCalled();
    expect(tree.root.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(1);
  });

  it('sells a locked free bundle as Free, never as a zero amount', () => {
    queryState.current = {
      data: { bundle: { viewerCanAccess: false, priceQuote: { formatted: '₹0' }, resources: null, lockedPreview: null } },
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    const tree = render(page());

    const values = textValues(tree);
    expect(values).toContain('Free');
    expect(values).not.toContain('₹0');
    expect(pressable(tree, 'Get resources — Free')).toBeDefined();
    expect(bundleContentProps).toHaveBeenCalledWith(expect.objectContaining({ resources: null }));
  });

  it('drops the sales pitch after unlock and keeps remix access as a flag, not a card', () => {
    queryState.current = {
      data: {
        bundle: {
          viewerCanAccess: true,
          priceQuote: { formatted: '₹0' },
          lockedPreview: null,
          resources: {
            promptText: null,
            notesMarkdown: null,
            workflowShareUrl: null,
            workflowSnapshot: null,
            attachments: [],
            allowRemix: false,
            items: [
              { id: 'prompt', type: 'prompt', title: 'Prompt', role: 'primary', sectionId: null, description: null, textContent: 'A hero in red', externalUrl: null, storagePath: null, contentType: null, sizeBytes: null, workflowSnapshot: null, sortOrder: 0, isPrimary: true, remixUse: 'none' },
              { id: 'remix', type: 'remix_access', title: 'Remix access', role: 'primary', sectionId: null, description: null, textContent: null, externalUrl: null, storagePath: null, contentType: null, sizeBytes: null, workflowSnapshot: null, sortOrder: 1, isPrimary: false, remixUse: 'none' },
            ],
          },
        },
      },
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    const tree = render(page());

    const values = textValues(tree);
    expect(values).toContain("Creator's resources");
    expect(values).toContain('Unlocked');
    expect(values).toContain('Remix included');
    expect(values).not.toContain('₹0');
    expect(values).not.toContain('Free');
    expect(values).not.toContain('The prompt, files and notes behind this result.');
    expect(pressable(tree, 'Get resources — Free')).toBeUndefined();

    const resources = bundleContentProps.mock.calls.at(-1)?.[0].resources;
    expect(resources.items.map((item: { type: string }) => item.type)).toEqual(['prompt']);
    expect(resources.allowRemix).toBe(false);
  });

  it('names the primary action after the source and leads with the creator', () => {
    const onRecreate = vi.fn();
    const onCreatorOpen = vi.fn();
    const onComments = vi.fn();
    const tree = render(page({ onRecreate, onCreatorOpen, onComments }));

    expect(pressable(tree, 'Remix')).toBeDefined();
    expect(pressable(tree, 'Recreate')).toBeUndefined();
    expect(textValues(tree)).toContain('Image · 2 comments');

    renderer.act(() => {
      pressable(tree, 'Remix').props.onPress();
      pressable(tree, 'Open @batman profile').props.onPress();
      pressable(tree, 'Comments').props.onPress();
    });
    expect(onRecreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
    expect(onCreatorOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1' }));
    expect(onComments).toHaveBeenCalledTimes(1);
  });

  it('has no page-level primary for a locked paid post', () => {
    const tree = render(page({
      item: showcaseItem({ availableActions: ['save', 'comment', 'share', 'unlock-remix', 'view-details'] }),
    }));

    expect(pressable(tree, 'Remix')).toBeUndefined();
    expect(pressable(tree, 'Recreate')).toBeUndefined();
  });

  it('carries its own header whose back returns to the media', () => {
    const onBack = vi.fn();
    const onActionsOpen = vi.fn();
    const tree = render(page({ onBack, onActionsOpen }));

    expect(textValues(tree)).toContain('Details');
    renderer.act(() => {
      pressable(tree, 'Back to media').props.onPress();
      pressable(tree, 'More options').props.onPress();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onActionsOpen).toHaveBeenCalledTimes(1);
  });

  it('calls the way back "Back to post" on a text post and hides the title the host printed', () => {
    const tree = render(page({
      hostRendersPostText: true,
      onBack: vi.fn(),
      item: showcaseItem({ previewKind: 'text', details: { ...showcaseItem().details!, unlock: null } }),
    }));

    expect(pressable(tree, 'Back to post')).toBeDefined();
    expect(textValues(tree)).not.toContain('Minnal Murali');
    expect(textValues(tree)).not.toContain("Creator's resources");
  });
});
