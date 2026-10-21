import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';

type MockProps = { children?: React.ReactNode; label?: string } & Record<string, unknown>;

const { authState, bundleContentProps, mutationOptions, queryOptions, queryState, mutationState, router, showActionSheet } = vi.hoisted(() => ({
  authState: {
    user: { id: 'viewer-1' } as { id: string } | null,
    api: { resolvePostResourceFileUrl: vi.fn() },
    credits: 2000 as number | null,
    updateCredits: vi.fn(),
  },
  bundleContentProps: vi.fn(),
  mutationOptions: { current: null as { onSuccess?: (result: unknown, variables: unknown) => Promise<void> } | null },
  queryOptions: { current: null as { queryKey?: unknown[] } | null },
  queryState: { current: { data: undefined as unknown, isError: false, error: null as unknown, refetch: vi.fn() } },
  mutationState: { mutate: vi.fn(), isPending: false, error: null as unknown },
  router: { push: vi.fn() },
  showActionSheet: vi.fn(),
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
    Crown: icon('crown'),
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
vi.mock('expo-router', () => ({ router }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    queryOptions.current = options;
    return queryState.current;
  },
  useMutation: (options: { onSuccess?: (result: unknown, variables: unknown) => Promise<void> }) => {
    mutationOptions.current = options;
    return mutationState;
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueriesData: vi.fn() }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/action-sheet', () => ({ showActionSheet }));

vi.mock('@/components/generation-references', () => ({
  GenerationOutputs: (props: MockProps) => React.createElement('generation-outputs', props),
  GenerationReferences: (props: MockProps) => React.createElement('generation-references', props),
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
  ResourceRevisionSwitch: ({ selected, onSelect }: { selected: string; onSelect: (revision: string) => void }) => React.createElement(
    'view',
    {},
    ['latest', 'purchased'].map((revision) => React.createElement('pressable', {
      key: revision,
      accessibilityLabel: `Show ${revision} recipe version`,
      accessibilityState: { selected: selected === revision },
      onPress: () => onSelect(revision),
    })),
  ),
}));

import { PostDetailsPage } from '@/components/post-details-page';
import { formatUnlockDate } from '@/lib/unlock-library-view-model';

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
  it('loads owner references only on the active creation details slide', () => {
    const item = showcaseItem({ sourceType: 'generation', generationId: 'owner-generation',
      details: { ...showcaseItem().details!, unlock: null } });
    const tree = render(page({ item }));
    expect(tree.root.findByType('generation-references' as never).props.generationId).toBe('owner-generation');
    renderer.act(() => tree.update(page({ item, active: false })));
    expect(tree.root.findAllByType('generation-references' as never)).toHaveLength(0);
    renderer.act(() => tree.update(page({ item: showcaseItem({ generationId: 'someone-elses-generation' }) })));
    expect(tree.root.findAllByType('generation-references' as never)).toHaveLength(0);
  });
  // The library sends a run's first file only; the details slide lists them all (audit 01-2).
  it('lists the outputs of a run that made several under its facts, on the active slide only', () => {
    const creation = (outputCount: number | null) => showcaseItem({
      sourceType: 'generation',
      generationId: 'owner-generation',
      details: {
        ...showcaseItem().details!,
        unlock: null,
        generationInfo: { model: 'Nano Banana 2', createdAt: '', duration: null, cost: 8, outputCount, inputMedia: null },
      },
    });
    const tree = render(page({ item: creation(3) }));
    expect(tree.root.findByType('generation-outputs' as never).props).toMatchObject({ generationId: 'owner-generation', count: 3 });
    const values = textValues(tree);
    expect(values.slice(values.indexOf('Outputs'), values.indexOf('Outputs') + 2)).toEqual(['Outputs', '3']);
    const order = tree.root.findAll((node) => ['generation-outputs', 'generation-references'].includes(String(node.type)))
      .map((node) => String(node.type));
    expect(order).toEqual(['generation-outputs', 'generation-references']);

    renderer.act(() => tree.update(page({ item: creation(3), active: false })));
    expect(tree.root.findAllByType('generation-outputs' as never)).toHaveLength(0);
    renderer.act(() => tree.update(page({ item: creation(null) })));
    expect(tree.root.findAllByType('generation-outputs' as never)).toHaveLength(0);
    expect(textValues(tree)).not.toContain('Outputs');
  });

  beforeEach(() => {
    bundleContentProps.mockClear();
    queryState.current = { data: undefined, isError: false, error: null, refetch: vi.fn() };
    authState.user = { id: 'viewer-1' };
    authState.credits = 2000;
    authState.updateCredits.mockClear();
    mutationState.mutate.mockClear();
    mutationOptions.current = null;
    router.push.mockClear();
    showActionSheet.mockClear();
  });

  it('shows no unlock button and no locked copy while the bundle is still loading', () => {
    const tree = render(page());

    const values = textValues(tree);
    expect(values).toContain('Recipe');
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
    expect(values).toContain('Recipe');
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
    // The Comments button carries the count, so the line under the title leaves it out (A5, 2026-10-21).
    expect(textValues(tree)).toContain('Image');
    expect(textValues(tree).filter((value) => value.includes('comment'))).toEqual([]);

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
    expect(textValues(tree)).not.toContain('Recipe');
  });
});

describe("unlocking the creator's resources", () => {
  const lockedBundle = (priceUsdCents: number) => ({
    data: { bundle: { viewerCanAccess: false, priceUsdCents, resources: null, lockedPreview: null } },
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  const paidItem = () => {
    const details = showcaseItem().details!;
    return showcaseItem({
      details: { ...details, unlock: { ...details.unlock!, accessMode: 'paid', priceLabel: '900 credits' } },
    });
  };

  beforeEach(() => {
    authState.user = { id: 'viewer-1' };
    authState.credits = 2000;
    authState.updateCredits.mockClear();
    mutationState.mutate.mockClear();
    mutationOptions.current = null;
    router.push.mockClear();
    showActionSheet.mockClear();
  });

  it('asks before a paid unlock spends credits, and spends only on the confirmed action', () => {
    queryState.current = lockedBundle(900);
    const tree = render(page({ item: paidItem() }));

    renderer.act(() => { pressable(tree, 'Unlock for 900 credits').props.onPress(); });
    expect(mutationState.mutate).not.toHaveBeenCalled();
    expect(showActionSheet).toHaveBeenCalledTimes(1);

    // The marketplace's own words for the same spend.
    const request = showActionSheet.mock.calls[0]?.[0] as {
      title: string;
      message: string;
      actions: Array<{ label: string; onPress: () => void }>;
    };
    expect(request.title).toBe('Unlock this resource?');
    expect(request.message).toBe('900 credits will come off your credit balance right away.');
    expect(request.actions.map((action) => action.label)).toEqual(['Unlock for 900 credits']);

    request.actions[0]!.onPress();
    expect(mutationState.mutate).toHaveBeenCalledTimes(1);
  });

  it('takes a free bundle in one tap', () => {
    queryState.current = lockedBundle(0);
    const tree = render(page());

    renderer.act(() => { pressable(tree, 'Get resources — Free').props.onPress(); });
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(mutationState.mutate).toHaveBeenCalledTimes(1);
  });

  it('applies the balance a credit unlock leaves, and leaves it alone when none comes back', async () => {
    queryState.current = lockedBundle(900);
    render(page({ item: paidItem() }));

    const target = { postId: 'post-1', resourceId: 'asset-1', accessMode: 'paid', priceUsdCents: 900 };
    await mutationOptions.current?.onSuccess?.({ success: true, entitlement: 'post_resource_unlock', credits: 1100 }, target);
    expect(authState.updateCredits).toHaveBeenCalledWith(1100);

    authState.updateCredits.mockClear();
    await mutationOptions.current?.onSuccess?.({ success: true, alreadyProcessed: false }, target);
    expect(authState.updateCredits).not.toHaveBeenCalled();
  });

  it('sends a signed-out reader to sign in and back to the post', () => {
    authState.user = null;
    queryState.current = lockedBundle(900);
    const tree = render(page({ item: paidItem(), authReturnTo: '/post/post-1' }));

    renderer.act(() => { pressable(tree, 'Sign in to unlock').props.onPress(); });
    expect(router.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/post/post-1' } });
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(mutationState.mutate).not.toHaveBeenCalled();
  });

  it('keeps the plain sign-in for a host that names no way back', () => {
    authState.user = null;
    queryState.current = lockedBundle(900);
    const tree = render(page({ item: paidItem() }));

    renderer.act(() => { pressable(tree, 'Sign in to unlock').props.onPress(); });
    expect(router.push).toHaveBeenCalledWith('/auth');
  });

  it('holds the spend and offers credits when the known balance is short', () => {
    authState.credits = 100;
    queryState.current = lockedBundle(900);
    const tree = render(page({ item: paidItem() }));

    expect(pressable(tree, 'Unlock for 900 credits').props.disabled).toBe(true);
    expect(textValues(tree)).toContain('You need 800 more credits for this unlock.');
    renderer.act(() => { pressable(tree, 'Unlock for 900 credits').props.onPress(); });
    expect(showActionSheet).not.toHaveBeenCalled();

    renderer.act(() => { pressable(tree, 'Get credits').props.onPress(); });
    expect(router.push).toHaveBeenCalledWith('/pricing');
  });

  it('offers no credits while the balance covers the price', () => {
    queryState.current = lockedBundle(900);
    const tree = render(page({ item: paidItem() }));

    expect(pressable(tree, 'Unlock for 900 credits').props.disabled).toBe(false);
    expect(pressable(tree, 'Get credits')).toBeUndefined();
  });
});

describe('the bundle read', () => {
  beforeEach(() => {
    authState.user = { id: 'viewer-1' };
    queryOptions.current = null;
    queryState.current = { data: undefined, isError: false, error: null, refetch: vi.fn() };
  });

  it("is keyed by the viewer, so another account never sees this one's unlock", () => {
    render(page());
    expect(queryOptions.current?.queryKey).toEqual(['post-resource-bundle', 'post-1', 'asset-1', 'viewer-1']);

    authState.user = null;
    render(page());
    expect(queryOptions.current?.queryKey).toEqual(['post-resource-bundle', 'post-1', 'asset-1', null]);
  });
});

describe('the locked card', () => {
  const updatedAt = '2026-10-03T10:00:00.000Z';
  const lockedPaid = (overrides: Record<string, unknown> = {}) => ({
    data: {
      bundle: {
        viewerCanAccess: false,
        accessMode: 'paid',
        priceUsdCents: 900,
        salesCount: 12,
        summary: 'Three looks from one prompt.',
        previewText: 'A teaser',
        resources: null,
        lockedPreview: { updatedAt, sectionCount: 1, itemCounts: { prompt: 1, reference_image: 3 } },
        ...overrides,
      },
    },
    isError: false,
    error: null,
    refetch: vi.fn(),
  });

  beforeEach(() => {
    authState.user = { id: 'viewer-1' };
    authState.credits = 2000;
  });

  it("sells the recipe the way the web does: its record, what it includes and the creator's summary", () => {
    queryState.current = lockedPaid();
    const details = showcaseItem().details!;
    const tree = render(page({
      item: showcaseItem({ details: { ...details, unlock: { ...details.unlock!, accessMode: 'paid', priceLabel: '900 credits' } } }),
    }));

    const values = textValues(tree);
    expect(values).toContain(`12 sold · Updated ${formatUnlockDate(updatedAt)}`);
    expect(values).toContain('Includes 1 section, 1 prompt, 3 reference images');
    expect(values).toContain('Three looks from one prompt.');
    expect(values).not.toContain('A teaser');
  });

  // A free unlock stopped counting as a sale (decision 6, 2026-10-17): a free
  // recipe's "opened" reads its free unlocks, not the sales it made while paid.
  it('counts a free recipe as opened, and falls back to the preview text without a summary', () => {
    queryState.current = lockedPaid({ accessMode: 'free', priceUsdCents: 0, summary: '  ', salesCount: 1, freeUnlockCount: 4 });
    const tree = render(page());

    const values = textValues(tree);
    expect(values).toContain(`4 opened · Updated ${formatUnlockDate(updatedAt)}`);
    expect(values).toContain('A teaser');
  });
});

describe('the unlocked card', () => {
  const resources = (text: string) => ({
    promptText: null,
    notesMarkdown: null,
    workflowShareUrl: null,
    workflowSnapshot: null,
    attachments: [],
    allowRemix: false,
    items: [
      { id: `prompt-${text}`, type: 'prompt', title: 'Prompt', role: 'primary', sectionId: null, description: null, textContent: text, externalUrl: null, storagePath: null, contentType: null, sizeBytes: null, workflowSnapshot: null, sortOrder: 0, isPrimary: true, remixUse: 'none' },
    ],
  });
  const unlocked = (overrides: Record<string, unknown> = {}) => ({
    data: { bundle: { viewerCanAccess: true, viewerIsOwner: false, lockedPreview: null, resources: resources('Latest prompt'), ...overrides } },
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  const lastContent = () => bundleContentProps.mock.calls.at(-1)?.[0] as {
    mediaItems: unknown[];
    resolveFileUrl: (storagePath: string) => Promise<string>;
    resources: { items: Array<{ textContent: string }> };
  };

  beforeEach(() => {
    bundleContentProps.mockClear();
    authState.user = { id: 'viewer-1' };
    authState.api.resolvePostResourceFileUrl.mockReset();
  });

  it("calls the creator's own recipe owner access, not an unlock", () => {
    queryState.current = unlocked({ viewerIsOwner: true });
    const tree = render(page());

    expect(textValues(tree)).toContain('Owner access');
    expect(textValues(tree)).not.toContain('Unlocked');
  });

  it('offers the version the buyer unlocked once the creator has edited it', () => {
    const purchasedMedia = [{ id: 'proof-1', mediaKey: 'proof-key', url: 'https://cdn.test/proof.jpg', mediaKind: 'image', sortOrder: 0 }];
    queryState.current = unlocked({
      purchasedRevision: {
        revisionNumber: 2,
        purchasedAt: '2026-09-01T00:00:00.000Z',
        title: 'Kit',
        summary: '',
        previewText: '',
        accessMode: 'paid',
        priceUsdCents: 500,
        resources: resources('Purchased prompt'),
        mediaItems: purchasedMedia,
      },
    });
    const tree = render(page());

    expect(textValues(tree)).toContain('The creator has updated this recipe since you bought it. You can read either version.');
    expect(lastContent().resources.items[0]?.textContent).toBe('Latest prompt');

    renderer.act(() => { pressable(tree, 'Show purchased recipe version').props.onPress(); });
    expect(lastContent().resources.items[0]?.textContent).toBe('Purchased prompt');
    expect(lastContent().mediaItems).toBe(purchasedMedia);
    expect(pressable(tree, 'Show purchased recipe version').props.accessibilityState).toEqual({ selected: true });

    renderer.act(() => { pressable(tree, 'Show latest recipe version').props.onPress(); });
    expect(lastContent().resources.items[0]?.textContent).toBe('Latest prompt');
  });

  it('shows no version switch while the bundle is the one the buyer unlocked', () => {
    queryState.current = unlocked();
    const tree = render(page());

    expect(pressable(tree, 'Show purchased recipe version')).toBeUndefined();
  });

  it("signs the bundle's files to open in place, through the batched signing", async () => {
    authState.api.resolvePostResourceFileUrl.mockResolvedValue('https://storage.test/signed');
    queryState.current = unlocked();
    render(page());

    await expect(lastContent().resolveFileUrl('refs/look.jpg')).resolves.toBe('https://storage.test/signed');
    expect(authState.api.resolvePostResourceFileUrl).toHaveBeenCalledWith('post-1', 'refs/look.jpg', { disposition: 'inline' });
  });
});

describe('a recipe opened from search', () => {
  const lockedFree = () => ({
    data: { bundle: { viewerCanAccess: false, accessMode: 'free', priceUsdCents: 0, resources: null, lockedPreview: null } },
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  // A prompt and a story, so both sections draw; no kinds, so the card prints
  // no "Prompt" of its own.
  const recipePost = () => {
    const details = showcaseItem().details!;
    return showcaseItem({
      details: { ...details, prompt: 'A hero in red', body: 'Shot at dusk.', unlock: { ...details.unlock!, resourceKinds: [] } },
    });
  };

  /** Every node of the page in the order it is drawn, which is the order it is read. */
  function drawOrder(tree: renderer.ReactTestRenderer) {
    const nodes: renderer.ReactTestInstance[] = [];
    const visit = (node: renderer.ReactTestInstance) => {
      nodes.push(node);
      for (const child of node.children) if (typeof child !== 'string') visit(child);
    };
    visit(tree.root);
    return nodes;
  }

  function heading(tree: renderer.ReactTestRenderer, title: string) {
    return tree.root.findAll((node) => String(node.type) === 'text' && node.props.children === title)[0];
  }

  function placeOf(tree: renderer.ReactTestRenderer, node: renderer.ReactTestInstance | undefined) {
    expect(node).toBeDefined();
    return drawOrder(tree).indexOf(node!);
  }

  beforeEach(() => {
    authState.user = { id: 'viewer-1' };
    queryState.current = lockedFree();
  });

  it("leads with the creator's resources, under the post's name and before its actions and sections", () => {
    const tree = render(page({ item: recipePost(), initialSection: 'resources', onCreatorOpen: vi.fn() }));

    const unlock = placeOf(tree, pressable(tree, 'Get resources — Free'));
    expect(placeOf(tree, heading(tree, 'Minnal Murali'))).toBeLessThan(unlock);
    expect(placeOf(tree, pressable(tree, 'Open @batman profile'))).toBeLessThan(unlock);
    expect(unlock).toBeLessThan(placeOf(tree, pressable(tree, 'Remix')));
    expect(unlock).toBeLessThan(placeOf(tree, pressable(tree, 'Save')));
    expect(unlock).toBeLessThan(placeOf(tree, heading(tree, 'Prompt')));
    expect(unlock).toBeLessThan(placeOf(tree, heading(tree, 'Story')));
    // Moved, not drawn twice.
    expect(textValues(tree).filter((value) => value === 'Recipe')).toHaveLength(1);
  });

  it('keeps the card where the page closes for every other way in', () => {
    for (const initialSection of [undefined, 'story', 'prompt'] as const) {
      const tree = render(page({ item: recipePost(), initialSection, onCreatorOpen: vi.fn() }));

      const unlock = placeOf(tree, pressable(tree, 'Get resources — Free'));
      expect(placeOf(tree, pressable(tree, 'Save'))).toBeLessThan(unlock);
      expect(placeOf(tree, heading(tree, 'Prompt'))).toBeLessThan(unlock);
      expect(placeOf(tree, heading(tree, 'Story'))).toBeLessThan(unlock);
      expect(textValues(tree).filter((value) => value === 'Recipe')).toHaveLength(1);
      renderer.act(() => tree.unmount());
    }
  });

  it('leads with the unlocked card too, once the reader owns the recipe', () => {
    queryState.current = {
      data: {
        bundle: {
          viewerCanAccess: true,
          viewerIsOwner: false,
          lockedPreview: null,
          resources: { promptText: null, notesMarkdown: 'Grade notes', workflowShareUrl: null, workflowSnapshot: null, attachments: [], allowRemix: false, items: [] },
        },
      },
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    const tree = render(page({ item: recipePost(), initialSection: 'resources' }));

    const card = placeOf(tree, heading(tree, 'Recipe'));
    expect(card).toBeLessThan(placeOf(tree, pressable(tree, 'Save')));
    expect(card).toBeLessThan(placeOf(tree, heading(tree, 'Prompt')));
    expect(textValues(tree)).toContain('Unlocked');
  });
});
