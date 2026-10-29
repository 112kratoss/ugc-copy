import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import {
  addPostResourceItemCountsToLockedPreview,
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PostResourceBundleLockedPreview,
  type PostResourceItem,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

const {
  mockPush,
  mockRefresh,
  mockRouter,
  mockUpdateCredits,
  mockVerifyCheckout,
  mockGetSession,
  authState,
} = vi.hoisted(() => {
  const push = vi.fn();
  const refresh = vi.fn();
  return {
    mockPush: push,
    mockRefresh: refresh,
    mockRouter: { push, refresh },
    mockUpdateCredits: vi.fn(),
    mockVerifyCheckout: vi.fn(),
    mockGetSession: vi.fn(),
    authState: {
      session: null as { access_token: string } | null,
      credits: null as number | null,
      marketplaceSpendableCredits: null as number | null,
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

// The browser session a checkout reads its bearer from after the sheet.
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

vi.mock('@/lib/razorpay-checkout-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/razorpay-checkout-client')>()),
  verifyRazorpayCheckoutUntilSettled: mockVerifyCheckout,
}));

// Spending credits asks first; these tests answer yes.
vi.mock('@/components/feedback-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/feedback-state')>()),
  requestConfirmation: vi.fn(async () => true),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    credits: authState.credits,
    marketplaceSpendableCredits: authState.marketplaceSpendableCredits,
    updateCredits: mockUpdateCredits,
  }),
}));

const PAYMENT_RECEIVED = "Payment received. Your recipe opens here once it's confirmed.";
const UNSPENDABLE_NOTE = "Welcome and referral credits can't be spent on recipes.";
const INTENT_KEY = 'magicbooklet:razorpay-checkout:post-resource:post-1';

const promptOnlyPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['prompt'],
  attachmentPreviews: [],
  itemCounts: { prompt: 1 },
  itemPreviews: [{
    type: 'prompt',
    title: 'Prompt',
    role: 'primary',
    remixUse: 'none',
  }],
  hasPrompt: true,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: false,
  updatedAt: '2026-04-25T10:00:00.000Z',
};

function renderPanel(overrides: Partial<Parameters<typeof PostResourceBundlePanel>[0]> = {}) {
  const resourceKinds: PostResourceKind[] = ['prompt'];

  return render(
    <PostResourceBundlePanel
      postId="post-1"
      title="Prompt unlock"
      summary="Unlock the prompt attached to this post."
      previewText=""
      priceLabel="$0.00"
      priceUsdCents={0}
      priceNote={null}
      isFree
      viewerCanAccess={false}
      viewerIsOwner={false}
      resourceKinds={resourceKinds}
      lockedPreview={promptOnlyPreview}
      salesCount={0}
      freeUnlockCount={0}
      initialResources={null}
      {...overrides}
    />
  );
}

const groupedItems: PostResourceItem[] = normalizePostResourceItems([
  {
    type: 'workflow',
    role: 'primary',
    title: 'Main workflow',
    externalUrl: 'https://example.com/workflow',
    remixUse: 'import_source',
    sortOrder: 0,
    isPrimary: true,
  },
  {
    type: 'workflow',
    role: 'supporting_workflow',
    title: 'Variation workflow',
    storagePath: 'user-1/workflows/variation.json',
    contentType: 'application/json',
    remixUse: 'none',
    sortOrder: 1,
    isPrimary: false,
  },
  {
    type: 'reference_image',
    role: 'style_reference',
    title: 'Style frame',
    storagePath: 'user-1/references/style.png',
    contentType: 'image/png',
    remixUse: 'reference_only',
    sortOrder: 2,
    isPrimary: false,
  },
  {
    type: 'reference_image',
    role: 'product_reference',
    title: 'Product frame',
    externalUrl: 'https://example.com/product.png',
    remixUse: 'reference_only',
    sortOrder: 3,
    isPrimary: false,
  },
]);

const groupedPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['workflow', 'files'],
  attachmentPreviews: [],
  itemCounts: {
    workflow: 2,
    reference_image: 2,
  },
  itemPreviews: groupedItems.map((item) => ({
    type: item.type,
    title: item.title,
    role: item.role,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    remixUse: item.remixUse,
  })),
  hasPrompt: false,
  hasNotes: false,
  hasWorkflow: true,
  hasRemix: false,
  updatedAt: '2026-04-25T10:00:00.000Z',
};

const sectionedResources = {
  sections: normalizePostResourceSections([
    {
      id: 'hook',
      title: 'Hook',
      kind: 'scene',
      description: 'Opening seven seconds',
    },
  ]),
  items: normalizePostResourceItems([
    {
      type: 'prompt',
      role: 'primary',
      title: 'Hook prompt',
      textContent: 'Open with the before state.',
      sectionId: 'hook',
    },
    {
      type: 'reference_image',
      role: 'style_reference',
      title: 'Global style reference',
      storagePath: 'user-1/references/style.png',
      contentType: 'image/png',
    },
  ]),
};

const sectionedPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['prompt', 'files'],
  attachmentPreviews: [],
  itemCounts: {
    prompt: 1,
    reference_image: 1,
  },
  sectionCount: 1,
  sectionPreviews: sectionedResources.sections.map((section) => ({
    id: section.id,
    title: section.title,
    kind: section.kind,
    description: section.description,
  })),
  itemPreviews: sectionedResources.items.map((item) => ({
    type: item.type,
    title: item.title,
    role: item.role,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    remixUse: item.remixUse,
    sectionId: item.sectionId,
  })),
  hasPrompt: true,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: false,
  updatedAt: '2026-04-25T10:00:00.000Z',
};

const explicitCardPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['files', 'remix'],
  attachmentPreviews: [],
  itemCounts: {
    reference_video: 2,
    remix_link: 1,
  },
  sectionCount: 1,
  sectionPreviews: [{
    id: 'hook-video',
    title: 'Private creator organization title',
    kind: 'scene',
    description: 'Private creator organization description',
  }],
  cardPreviews: [{
    sectionId: 'hook-video',
    publicTitle: 'Hook video references',
    resourceType: 'reference_video',
    scope: { kind: 'media', mediaKeys: ['media-1', 'media-2'] },
    itemCount: 2,
    hasRemix: true,
  }],
  itemPreviews: [{
    type: 'reference_video',
    title: 'private-client-filename.mov',
    role: 'style_reference',
    sectionId: 'hook-video',
    remixUse: 'reference_only',
  }],
  hasPrompt: false,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: true,
  updatedAt: '2026-04-25T10:00:00.000Z',
};

const multiTypeSectionedResources = {
  sections: normalizePostResourceSections([
    {
      id: 'hero-output',
      title: 'Hero output',
      kind: 'scene',
      description: 'Resources for the hero output',
    },
  ]),
  items: normalizePostResourceItems([
    {
      type: 'reference_video',
      title: 'Motion reference',
      externalUrl: 'https://example.com/motion-reference.mp4',
      sectionId: 'hero-output',
      scope: { kind: 'media', mediaKeys: ['media-1'] },
    },
    {
      type: 'remix_link',
      title: 'Open remix template',
      externalUrl: 'https://example.com/remix',
      sectionId: 'hero-output',
      scope: { kind: 'media', mediaKeys: ['media-1', 'media-2'] },
    },
    {
      type: 'reference_audio',
      title: 'Shared voice reference',
      externalUrl: 'https://example.com/voice-reference.mp3',
      scope: { kind: 'all' },
    },
  ]),
};

const publicRecipeItems = normalizePostResourceItems([
  {
    type: 'prompt',
    title: 'Prompt',
    textContent: 'Public recipe prompt',
  },
  {
    type: 'reference_image',
    role: 'style_reference',
    title: 'Image input',
    storagePath: 'user-1/generation-references/gen-1/input.png',
    contentType: 'image/png',
  },
  {
    type: 'note',
    title: 'Notes',
    textContent: 'Public recipe notes',
  },
]);

const publicRecipePreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['prompt', 'files', 'notes'],
  attachmentPreviews: [],
  itemCounts: {
    prompt: 1,
    reference_image: 1,
    note: 1,
  },
  itemPreviews: publicRecipeItems.map((item) => ({
    type: item.type,
    title: item.title,
    role: item.role,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    remixUse: item.remixUse,
  })),
  hasPrompt: true,
  hasNotes: true,
  hasWorkflow: false,
  hasRemix: false,
  updatedAt: '2026-04-25T10:00:00.000Z',
};

describe('PostResourceBundlePanel', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockRefresh.mockClear();
    mockUpdateCredits.mockClear();
    mockVerifyCheckout.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'token-fresh' } } });
    authState.session = null;
    authState.credits = null;
    authState.marketplaceSpendableCredits = null;
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    document.getElementById('post-resource-bundle-razorpay-checkout')?.remove();
  });

  it('keeps locked prompt-only unlocks compact with one open action', () => {
    renderPanel({
      isFree: false,
      priceLabel: '$9.00',
      priceUsdCents: 900,
    });

    expect(screen.getByRole('button', { name: /^pay \$9\.00/i })).toBeInTheDocument();
    expect(screen.getByText(/the prompt text stays locked until this recipe is unlocked/i)).toBeInTheDocument();
    expect(screen.queryByText(/labels and file types can be shown publicly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });

  it('shows the parts of a free recipe the viewer already has, with its status chip', () => {
    renderPanel({
      title: 'Creation recipe',
      summary: 'Prompt, notes, and references used for this result.',
      resourceKinds: ['prompt', 'files', 'notes'],
      lockedPreview: publicRecipePreview,
      viewerCanAccess: true,
      initialResources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        items: publicRecipeItems,
      },
    });

    // The content is the message: an open recipe shows its parts directly,
    // with just the status chip saying it is the viewer's ("Unlocked", as on
    // every card of a recipe they have, free or paid).
    expect(screen.getByText('Unlocked')).toBeInTheDocument();
    expect(screen.queryByText('Free recipe')).not.toBeInTheDocument();
    expect(screen.getByText('Public recipe prompt')).toBeInTheDocument();
    expect(screen.getByText('Public recipe notes')).toBeInTheDocument();
    expect(screen.getByText('Image input')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /get free recipe/i })).toBeNull();
    expect(screen.queryByText(/buyer trust/i)).toBeNull();
    expect(screen.queryByText(/digital recipes are final sale/i)).toBeNull();
  });

  it('offers one-click access for a gated free recipe without checkout choices', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: /get free recipe/i })).toBeInTheDocument();
    expect(screen.getByText(/get the full recipe free with one click/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pay /i })).toBeNull();
  });

  it('shows owner prompt access with buyer-facing context', () => {
    renderPanel({
      viewerIsOwner: true,
      initialResources: {
        promptText: 'secret prompt',
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
      },
    });

    expect(screen.getByText('secret prompt')).toBeInTheDocument();
    expect(screen.getByText(/owner preview\. people add this recipe before seeing it/i)).toBeInTheDocument();
  });

  it('keeps locked content private without introducing license terms yet', () => {
    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
      priceNote: 'Charged in INR for buyers in India.',
    });

    expect(screen.getByRole('button', { name: /^pay ₹189/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeInTheDocument();
    expect(screen.getByText(/credit cost: 900 credits/i)).toBeInTheDocument();
    // Both ways to pay, named in the price chip.
    expect(screen.getByText('₹189 · 900 credits')).toBeInTheDocument();
    expect(screen.queryByText(/digital recipes are final sale/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/do not resell, redistribute, or claim the raw bundle as your own/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });

  it('shows grouped item counts before access and grouped resources after access', () => {
    // Locked: the pitch summarizes what is inside without leaking it.
    const locked = renderPanel({
      resourceKinds: ['workflow', 'files'],
      lockedPreview: groupedPreview,
      initialResources: null,
    });

    // Counted in the order the recipe reads once unlocked: references before workflows.
    expect(screen.getByText(/includes 2 reference images, 2 workflows/i)).toBeInTheDocument();
    expect(screen.queryByText('Main workflow')).not.toBeInTheDocument();

    locked.unmount();

    // Unlocked: no table of contents, just the grouped resources themselves.
    renderPanel({
      resourceKinds: ['workflow', 'files'],
      lockedPreview: groupedPreview,
      initialResources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        items: groupedItems,
      },
      viewerCanAccess: true,
    });

    expect(screen.queryByText(/includes 2 reference images, 2 workflows/i)).not.toBeInTheDocument();
    // A recipe with no cards reads by kind, the order both clients share:
    // the pictures as one gallery, then the workflows (recipe reading review,
    // 2026-10-29). The web used to list them flat while the app grouped them.
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['References', 'Workflows']);
    expect(screen.getByText('2 images')).toBeInTheDocument();
    const titles = ['Style frame', 'Product frame', 'Main workflow', 'Variation workflow'];
    const positions = titles.map((title) => document.body.textContent?.indexOf(title) ?? -1);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  // Recipe reading review B3 (2026-10-29): the server counts a creation's saved
  // inputs into the teaser of a recipe whose creator shares them (post
  // 6487f689 read "1 prompt" and unlocked a prompt, three pictures and a clip).
  it('counts the creation’s references a locked creation recipe comes with, after its prompt', () => {
    const lockedPreview = addPostResourceItemCountsToLockedPreview(
      { ...promptOnlyPreview, resourceKinds: ['prompt', 'remix'], hasRemix: true },
      { reference_image: 3, reference_video: 1 },
    );

    renderPanel({ resourceKinds: lockedPreview.resourceKinds, lockedPreview, remixIncluded: true });

    expect(screen.getByText('Includes 1 prompt, 3 reference images, 1 reference video')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Remix included')).toBeInTheDocument();
    // Counted, never shown: nothing of the references themselves while locked.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'References' })).not.toBeInTheDocument();
  });

  it('shows section counts while locked and groups unlocked resources by section', () => {
    const locked = renderPanel({
      resourceKinds: ['prompt', 'files'],
      lockedPreview: sectionedPreview,
      initialResources: null,
    });

    // A card is how the creator arranged it, not something a buyer gets (B-F16).
    expect(screen.getByText(/includes 1 prompt, 1 reference image/i)).toBeInTheDocument();
    expect(screen.queryByText('Hook prompt')).not.toBeInTheDocument();

    locked.unmount();

    renderPanel({
      resourceKinds: ['prompt', 'files'],
      lockedPreview: sectionedPreview,
      initialResources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        sections: sectionedResources.sections,
        items: sectionedResources.items,
      },
      viewerCanAccess: true,
    });

    // The creator's card first, then the pictures it has no card for, named
    // for what they are where they used to read "More from this post".
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Hook', 'References']);
    expect(screen.getByText('Hook prompt')).toBeInTheDocument();
    expect(screen.getByText('Global style reference')).toBeInTheDocument();
  });

  it('renders only explicit public resource cards while a bundle is locked', () => {
    renderPanel({
      resourceKinds: ['files', 'remix'],
      lockedPreview: explicitCardPreview,
    });

    expect(screen.getByText('Hook video references')).toBeInTheDocument();
    // The title already says what the card is, so its line counts it and says where it applies.
    expect(screen.getByText('2 items · Applies to 2 selected outputs')).toBeInTheDocument();
    expect(screen.getByText('Remix included')).toBeInTheDocument();
    expect(screen.queryByText('Private creator organization title')).not.toBeInTheDocument();
    expect(screen.queryByText('Private creator organization description')).not.toBeInTheDocument();
    expect(screen.queryByText('private-client-filename.mov')).not.toBeInTheDocument();
  });

  // Mobile has had an output filter for scoped resources for a while; web only
  // printed a count, so a buyer could never tell which image a prompt belonged
  // to.
  describe('per-output filtering', () => {
    const scopedMediaItems = [
      { id: 'm1', mediaKey: 'media-1', url: '/a.png', mediaKind: 'image' as const },
      { id: 'm2', mediaKey: 'media-2', url: '/b.png', mediaKind: 'image' as const },
    ] as unknown as NonNullable<Parameters<typeof PostResourceBundlePanel>[0]['mediaItems']>;

    it('filters locked cards down to the selected output', () => {
      renderPanel({
        resourceKinds: ['files', 'remix'],
        lockedPreview: explicitCardPreview,
        mediaItems: scopedMediaItems,
      });

      expect(screen.getByRole('button', { name: /all items/i })).toBeInTheDocument();
      expect(screen.getByText('Hook video references')).toBeInTheDocument();

      // The card is scoped to media-1 and media-2, so a third output hides it.
      fireEvent.click(screen.getByRole('button', { name: /show items for output 1/i }));
      expect(screen.getByText('Hook video references')).toBeInTheDocument();
    });

    it('stays hidden when nothing is scoped to a specific output', () => {
      renderPanel({ mediaItems: scopedMediaItems });

      expect(screen.queryByRole('button', { name: /all items/i })).not.toBeInTheDocument();
    });

    it('stays hidden when the post has a single output', () => {
      renderPanel({
        resourceKinds: ['files', 'remix'],
        lockedPreview: explicitCardPreview,
        mediaItems: scopedMediaItems.slice(0, 1),
      });

      expect(screen.queryByRole('button', { name: /all items/i })).not.toBeInTheDocument();
    });

    it('says so when the selected output has no resources at all', () => {
      renderPanel({
        resourceKinds: ['files', 'remix'],
        lockedPreview: {
          ...explicitCardPreview,
          cardPreviews: [{
            ...explicitCardPreview.cardPreviews![0]!,
            scope: { kind: 'media', mediaKeys: ['media-2'] },
          }],
        },
        mediaItems: scopedMediaItems,
      });

      fireEvent.click(screen.getByRole('button', { name: /show items for output 1/i }));
      expect(screen.queryByText('Hook video references')).not.toBeInTheDocument();
      expect(screen.getByText(/no items apply to this output/i)).toBeInTheDocument();
    });

    // A section carries a scope of its own, and its items may leave theirs at
    // the default -- so filtering on items alone showed a narrowed section
    // under every output.
    it('hides a whole section whose own scope excludes the selected output', () => {
      renderPanel({
        viewerCanAccess: true,
        resourceKinds: ['files'],
        mediaItems: scopedMediaItems,
        initialResources: {
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
          sections: normalizePostResourceSections([
            {
              id: 'hero-output',
              title: 'Hero output',
              kind: 'scene',
              publicTitle: 'Hero output',
              scope: { kind: 'media', mediaKeys: ['media-1'] },
            },
          ]),
          items: normalizePostResourceItems([
            {
              type: 'reference_video',
              title: 'Motion reference',
              externalUrl: 'https://example.com/motion-reference.mp4',
              sectionId: 'hero-output',
              scope: { kind: 'all' },
            },
          ]),
        },
      });

      expect(screen.getByText('Hero output')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /show items for output 2/i }));
      expect(screen.queryByText('Hero output')).not.toBeInTheDocument();
      expect(screen.getByText(/no items apply to this output/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /show items for output 1/i }));
      expect(screen.getByText('Hero output')).toBeInTheDocument();
      expect(screen.queryByText(/no items apply to this output/i)).not.toBeInTheDocument();
    });

    it('narrows items inside a section that does match the selected output', () => {
      renderPanel({
        viewerCanAccess: true,
        resourceKinds: ['files'],
        mediaItems: scopedMediaItems,
        initialResources: {
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
          sections: normalizePostResourceSections([
            {
              id: 'hero-output',
              title: 'Hero output',
              kind: 'scene',
              publicTitle: 'Hero output',
              scope: { kind: 'media', mediaKeys: ['media-1', 'media-2'] },
            },
          ]),
          items: normalizePostResourceItems([
            {
              type: 'reference_video',
              title: 'Second output only',
              externalUrl: 'https://example.com/second.mp4',
              sectionId: 'hero-output',
              scope: { kind: 'media', mediaKeys: ['media-2'] },
            },
            {
              type: 'reference_audio',
              title: 'Both outputs',
              externalUrl: 'https://example.com/voice.mp3',
              sectionId: 'hero-output',
              scope: { kind: 'all' },
            },
          ]),
        },
      });

      fireEvent.click(screen.getByRole('button', { name: /show items for output 1/i }));
      expect(screen.getByText('Hero output')).toBeInTheDocument();
      expect(screen.getByText('Both outputs')).toBeInTheDocument();
      expect(screen.queryByText('Second output only')).not.toBeInTheDocument();
    });

    // An empty media scope narrows nothing, so it must not hide itself under
    // every filter -- the mobile panel normalizes it to "all" for this reason.
    it('treats a media scope naming no output as applying to all of them', () => {
      renderPanel({
        resourceKinds: ['files', 'remix'],
        lockedPreview: {
          ...explicitCardPreview,
          cardPreviews: [
            { ...explicitCardPreview.cardPreviews![0]!, scope: { kind: 'media', mediaKeys: ['media-1'] } },
            {
              sectionId: 'everything',
              publicTitle: 'Applies everywhere',
              resourceType: 'note',
              scope: { kind: 'media', mediaKeys: [] },
              itemCount: 1,
              hasRemix: false,
            },
          ],
        },
        mediaItems: scopedMediaItems,
      });

      fireEvent.click(screen.getByRole('button', { name: /show items for output 2/i }));
      expect(screen.getByText('Applies everywhere')).toBeInTheDocument();
    });

    it('switches to purchase-time proof outputs with the purchased revision', () => {
      const currentMediaItems = [
        ...scopedMediaItems,
        { ...scopedMediaItems[0], id: 'm3', mediaKey: 'media-3', url: '/c.png' },
      ];
      renderPanel({
        viewerCanAccess: true,
        resourceKinds: ['prompt'],
        mediaItems: currentMediaItems,
        initialResources: {
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
          sections: normalizePostResourceSections([{
            id: 'latest', title: 'Latest output', kind: 'asset_group', scope: { kind: 'media', mediaKeys: ['media-3'] },
          }]),
          items: normalizePostResourceItems([{
            type: 'prompt', title: 'Latest prompt', textContent: 'Latest', sectionId: 'latest', scope: { kind: 'all' },
          }]),
        },
        purchasedRevision: {
          revisionNumber: 1,
          purchasedAt: '2026-07-01T00:00:00.000Z',
          title: 'Purchased kit',
          summary: 'Purchased summary',
          previewText: 'Purchased preview',
          accessMode: 'paid',
          priceUsdCents: 500,
          mediaItems: [
            { ...scopedMediaItems[0], id: 'old-1', mediaKey: 'old-media-1' },
            { ...scopedMediaItems[1], id: 'old-2', mediaKey: 'old-media-2' },
          ],
          resources: {
            promptText: null,
            notesMarkdown: null,
            workflowShareUrl: null,
            attachments: [],
            allowRemix: false,
            sections: normalizePostResourceSections([{
              id: 'purchased', title: 'Purchased output', kind: 'asset_group', scope: { kind: 'media', mediaKeys: ['old-media-1'] },
            }]),
            items: normalizePostResourceItems([{
              type: 'prompt', title: 'Purchased prompt', textContent: 'Purchased', sectionId: 'purchased', scope: { kind: 'all' },
            }]),
          },
        },
      });

      expect(screen.getByRole('button', { name: /show items for output 3/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /the version you unlocked/i }));

      expect(screen.queryByRole('button', { name: /show items for output 3/i })).not.toBeInTheDocument();
      expect(screen.getByText('Purchased output')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /show items for output 2/i }));
      expect(screen.getByText(/no items apply to this output/i)).toBeInTheDocument();
    });
  });

  // A free unlock stopped counting as a sale on 2026-10-17 (decision 6): a
  // free recipe's line counts its free unlocks, a paid one's its paid sales.
  it.each([
    ['a free recipe its free unlocks', { isFree: true, salesCount: 0, freeUnlockCount: 5 }, '5 opened'],
    [
      'a paid recipe its paid sales',
      { isFree: false, priceLabel: '$9.00', priceUsdCents: 900, salesCount: 3, freeUnlockCount: 2 },
      '3 sold',
    ],
  ])('counts for %s', (_name, props, label) => {
    renderPanel(props);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('switches the purchased revision metadata together with its resources', () => {
    renderPanel({
      title: 'Latest launch kit',
      summary: 'Latest summary',
      previewText: 'Latest preview',
      isFree: false,
      priceLabel: '$9.00',
      priceUsdCents: 900,
      salesCount: 3,
      viewerCanAccess: true,
      initialResources: {
        promptText: 'Latest prompt',
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
      },
      purchasedRevision: {
        revisionNumber: 2,
        purchasedAt: '2026-07-01T00:00:00.000Z',
        title: 'Original launch kit',
        summary: 'Original summary',
        previewText: 'Original preview',
        accessMode: 'free',
        priceUsdCents: 0,
        resources: {
          promptText: 'Original prompt',
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
        },
      },
    });

    expect(screen.getByRole('heading', { name: 'Latest launch kit' })).toBeInTheDocument();
    expect(screen.getByText('Latest prompt')).toBeInTheDocument();
    expect(screen.getByText('Latest summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /the version you unlocked/i }));

    expect(screen.getByRole('heading', { name: 'Original launch kit' })).toBeInTheDocument();
    expect(screen.getByText('Original prompt')).toBeInTheDocument();
    expect(screen.getByText('Original summary')).toBeInTheDocument();
    expect(screen.getByText(/purchased version/i)).toHaveTextContent('Free');
    expect(screen.queryByText('Latest prompt')).not.toBeInTheDocument();
  });

  it('shows an explicit public card even for an otherwise prompt-only bundle', () => {
    renderPanel({
      lockedPreview: {
        ...promptOnlyPreview,
        cardPreviews: [{
          sectionId: 'prompt-card',
          publicTitle: 'Product photo prompt',
          resourceType: 'prompt',
          scope: { kind: 'all' },
          itemCount: 1,
          hasRemix: false,
        }],
        itemPreviews: [{
          ...promptOnlyPreview.itemPreviews[0],
          title: 'Private working prompt title',
        }],
      },
    });

    expect(screen.getByText('Product photo prompt')).toBeInTheDocument();
    // The default scope is silent — only a narrowed scope earns a label.
    expect(screen.queryByText('Applies to all outputs')).not.toBeInTheDocument();
    expect(screen.queryByText('Private working prompt title')).not.toBeInTheDocument();
  });

  it('renders every supported grouped resource type with understandable output scopes', () => {
    renderPanel({
      resourceKinds: ['files', 'remix'],
      lockedPreview: explicitCardPreview,
      initialResources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: true,
        sections: multiTypeSectionedResources.sections,
        items: multiTypeSectionedResources.items,
      },
      viewerCanAccess: true,
    });

    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Hero output', 'References']);
    // Each item under its own title, its link named by what it opens (B-F17);
    // a picture or clip under its name in the gallery, with its outputs.
    expect(screen.getByRole('link', { name: 'Open remix' })).toHaveAttribute('href', 'https://example.com/remix');
    expect(screen.getByText('Motion reference')).toBeInTheDocument();
    expect(screen.getByText('Shared voice reference')).toBeInTheDocument();
    expect(screen.getByText('Open remix template')).toBeInTheDocument();
    expect(screen.getByText('Applies to 1 selected output')).toBeInTheDocument();
    expect(screen.getByText('Applies to 2 selected outputs')).toBeInTheDocument();
    // The default scope carries no information, so it renders nothing.
    expect(screen.queryByText('Applies to all outputs')).not.toBeInTheDocument();
  });

  it('keeps paid packages below 100 tokens credit-only on web', () => {
    renderPanel({
      isFree: false,
      priceLabel: '$0.50',
      priceUsdCents: 50,
      priceNote: 'Cash conversion note',
    });

    expect(screen.queryByRole('button', { name: /^pay /i })).toBeNull();
    expect(screen.getByRole('button', { name: /use 50 credits/i })).toBeInTheDocument();
    expect(screen.getByText('Credit-only purchase')).toBeInTheDocument();
    expect(screen.getByText(/unlock the full recipe for 50 credits/i)).toBeInTheDocument();
    expect(screen.queryByText('Cash conversion note')).not.toBeInTheDocument();
  });

  it('unlocks paid post resources with credits and refreshes the revealed bundle', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/unlock-with-credits')) {
        return new Response(JSON.stringify({
          success: true,
          credits: 100,
        }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: {
              promptText: 'revealed prompt',
              notesMarkdown: null,
              workflowShareUrl: null,
              attachments: [],
              allowRemix: false,
            },
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
    });

    fireEvent.click(screen.getByRole('button', { name: /use 900 credits/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-with-credits', expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-1',
        },
        // The price the buyer confirmed (S3).
        body: JSON.stringify({ expectedPriceCredits: 900 }),
      }));
    });
    expect(mockUpdateCredits).toHaveBeenCalledWith(100);
    expect(await screen.findByText('revealed prompt')).toBeInTheDocument();
  });

  it('shows a credit top-up path when the viewer has insufficient credits', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 120;
    authState.marketplaceSpendableCredits = 120;

    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
    });

    expect(screen.getByText(/120 credits available/i)).toBeInTheDocument();
    expect(screen.queryByText(UNSPENDABLE_NOTE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeDisabled();
    // With the way back to this recipe (B-F8).
    expect(screen.getByRole('link', { name: /buy credits/i })).toHaveAttribute('href', `/pricing?returnTo=${encodeURIComponent('/showcase/post-1#recipe')}`);
  });

  // A new account holds only welcome credits: the total covers the price, the
  // unlock would refuse it, and the page used to offer the spend anyway.
  it('judges the shortfall on the spendable credits alone, and says why the total does not count', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;
    authState.marketplaceSpendableCredits = 0;

    renderPanel({ isFree: false, priceLabel: '₹189', priceUsdCents: 900 });

    expect(screen.getByText('0 credits available')).toBeInTheDocument();
    expect(screen.queryByText(/1,200 credits available/)).not.toBeInTheDocument();
    expect(screen.getByText(UNSPENDABLE_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeDisabled();
    // With the way back to this recipe (B-F8).
    expect(screen.getByRole('link', { name: /buy credits/i })).toHaveAttribute('href', `/pricing?returnTo=${encodeURIComponent('/showcase/post-1#recipe')}`);
  });

  it('prints the spendable balance and the note when only part of the balance can buy recipes', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1500;
    authState.marketplaceSpendableCredits = 1200;

    renderPanel({ isFree: false, priceLabel: '₹189', priceUsdCents: 900 });

    expect(screen.getByText('1,200 credits available')).toBeInTheDocument();
    expect(screen.getByText(UNSPENDABLE_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeEnabled();
    expect(screen.queryByRole('link', { name: /buy credits/i })).not.toBeInTheDocument();
  });

  it('claims no shortfall and prints no balance while the spendable figure is unknown', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 120;
    authState.marketplaceSpendableCredits = null;

    renderPanel({ isFree: false, priceLabel: '₹189', priceUsdCents: 900 });

    expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeEnabled();
    expect(screen.queryByRole('link', { name: /buy credits/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/credits available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sign in to see your credit balance/i)).not.toBeInTheDocument();
  });

  it("offers Buy credits once the unlock refuses for credits, and takes the server's balance", async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith('/unlock-with-credits')) {
        return new Response(JSON.stringify({
          error: 'Insufficient credits. This unlock costs 900 credits.',
          code: 'INSUFFICIENT_CREDITS',
          creditCost: 900,
          remainingCredits: 1200,
          marketplaceSpendableCredits: 0,
        }), { status: 402 });
      }
      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ isFree: false, priceLabel: '₹189', priceUsdCents: 900 });
    expect(screen.queryByRole('link', { name: /buy credits/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /use 900 credits/i }));

    expect(await screen.findByText('Insufficient credits. This unlock costs 900 credits.')).toBeInTheDocument();
    expect(mockUpdateCredits).toHaveBeenCalledWith(1200, { marketplaceSpendableCredits: 0 });
    // With the way back to this recipe (B-F8).
    expect(screen.getByRole('link', { name: /buy credits/i })).toHaveAttribute('href', `/pricing?returnTo=${encodeURIComponent('/showcase/post-1#recipe')}`);
  });

  it('hands the spendable figure the unlock answered to the balance with the new total', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1500;
    authState.marketplaceSpendableCredits = 1200;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith('/unlock-with-credits')) {
        return new Response(JSON.stringify({ success: true, credits: 600, marketplaceSpendableCredits: 300 }));
      }
      return new Response(JSON.stringify({
        bundle: { viewerCanAccess: true, viewerIsOwner: false, resources: null },
      }));
    }));

    renderPanel({ isFree: false, priceLabel: '₹189', priceUsdCents: 900 });
    fireEvent.click(screen.getByRole('button', { name: /use 900 credits/i }));

    await waitFor(() => {
      expect(mockUpdateCredits).toHaveBeenCalledWith(600, { marketplaceSpendableCredits: 300 });
    });
  });

  it('keeps the Razorpay checkout route wired for paid post resources', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/order')) {
        return new Response(JSON.stringify({
          alreadyPurchased: true,
        }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: null,
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
    });

    fireEvent.click(screen.getByRole('button', { name: /^pay ₹189/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/order', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  it('prices the latest and the purchased version in one currency', () => {
    renderPanel({
      isFree: false,
      priceLabel: '₹750',
      priceUsdCents: 900,
      viewerCanAccess: true,
      initialResources: {
        promptText: 'Latest prompt',
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
      },
      purchasedRevision: {
        revisionNumber: 1,
        purchasedAt: '2026-07-01T00:00:00.000Z',
        title: 'Prompt unlock',
        summary: '',
        previewText: '',
        accessMode: 'paid',
        priceUsdCents: 500,
        resources: {
          promptText: 'Original prompt',
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
        },
      },
    });

    expect(screen.getByText(/latest version ·/i)).toHaveTextContent('Latest version · $9.00 · 900 credits');
    fireEvent.click(screen.getByRole('button', { name: /the version you unlocked/i }));
    expect(screen.getByText(/purchased version ·/i)).toHaveTextContent('Purchased version · $5.00 · 500 credits');
  });

  describe('resource files', () => {
    const mediaItems = normalizePostResourceItems([
      { type: 'reference_image', title: 'Reference 1', storagePath: 'user-1/references/frame.png', contentType: 'image/png' },
      { type: 'reference_video', title: 'Motion', storagePath: 'user-1/references/motion.mp4', contentType: 'video/mp4' },
      { type: 'reference_audio', title: 'Voice', storagePath: 'user-1/references/voice.mp3', contentType: 'audio/mpeg' },
    ]);

    function unlockedWith(items: PostResourceItem[]) {
      return {
        viewerCanAccess: true,
        resourceKinds: ['files'] as PostResourceKind[],
        initialResources: {
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
          items,
        },
      };
    }

    // Answers both forms: a batch with every path it was asked for, a single
    // path with a URL that names the disposition it was signed for.
    function stubFileUrlFetch() {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (Array.isArray(body.storagePaths)) {
          return new Response(JSON.stringify({
            files: body.storagePaths.map((storagePath: string) => ({
              storagePath,
              url: `https://signed.example.com/${storagePath}`,
            })),
          }));
        }
        return new Response(JSON.stringify({
          success: true,
          signedUrl: `https://signed.example.com/${body.disposition}/${body.storagePath}`,
        }));
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('signs every preview it draws in one request, to be shown inline', async () => {
      const fetchMock = stubFileUrlFetch();
      const { container } = renderPanel(unlockedWith(mediaItems));

      await waitFor(() => {
        expect(container.querySelector('img')).toHaveAttribute('src', 'https://signed.example.com/user-1/references/frame.png');
      });
      // A clip's first frame stands in for its poster.
      expect(container.querySelector('video')).toHaveAttribute('src', 'https://signed.example.com/user-1/references/motion.mp4#t=0.1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/posts/post-1/resource-bundle/file-url');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        storagePaths: mediaItems.map((item) => item.storagePath),
        disposition: 'inline',
      });
    });

    it('signs previews in one request on the buyer library route too, which takes the same batch form', async () => {
      const fetchMock = stubFileUrlFetch();
      renderPanel({
        ...unlockedWith(mediaItems.slice(0, 2)),
        fileUrlEndpoint: '/api/me/unlocks/unlock-1/file-url',
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
        ['/api/me/unlocks/unlock-1/file-url', {
          storagePaths: ['user-1/references/frame.png', 'user-1/references/motion.mp4'],
          disposition: 'inline',
        }],
      ]);
    });

    it('opens a file in the browser and saves a download under a name with its extension', async () => {
      stubFileUrlFetch();
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      const saved: Array<{ href: string; download: string }> = [];
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        saved.push({ href: this.href, download: this.download });
      });
      try {
        renderPanel(unlockedWith(normalizePostResourceItems([
          mediaItems[0],
          { type: 'source_file', title: 'Brief', storagePath: 'user-1/files/brief.pdf', contentType: 'application/pdf', sizeBytes: 2_202_009 },
        ])));

        // A file a reader opens rather than looks at keeps its row, with its type in words.
        expect(screen.getByText('PDF · 2.1 MB')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
        await waitFor(() => {
          expect(open).toHaveBeenCalledWith(
            'https://signed.example.com/inline/user-1/files/brief.pdf',
            '_blank',
            'noopener,noreferrer',
          );
        });

        fireEvent.click(screen.getByRole('button', { name: 'Download Reference 1' }));
        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        await waitFor(() => {
          expect(saved).toEqual([
            { href: 'https://signed.example.com/attachment/user-1/references/frame.png', download: 'Reference 1.png' },
            { href: 'https://signed.example.com/attachment/user-1/files/brief.pdf', download: 'Brief.pdf' },
          ]);
        });
      } finally {
        open.mockRestore();
        click.mockRestore();
      }
    });

    it('opens a picture full screen on the link its thumbnail already holds, from the cache', async () => {
      const fetchMock = stubFileUrlFetch();
      renderPanel(unlockedWith(mediaItems));

      await waitFor(() => expect(screen.getByRole('button', { name: 'View Reference 1' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'View Reference 1' }));

      const viewer = await screen.findByRole('dialog', { name: 'References' });
      expect(viewer.querySelector('img[src="https://signed.example.com/user-1/references/frame.png"]')).not.toBeNull();
      // Drawn over the page, not inside the post column, whose stacking the top bar sits above.
      expect(viewer.closest('section')).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'Close media' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('signs the view anew, in one request, once the thumbnails\' links are near their ten minutes', async () => {
      const fetchMock = stubFileUrlFetch();
      const start = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(start);
      try {
        renderPanel(unlockedWith(mediaItems));
        await waitFor(() => expect(screen.getByRole('button', { name: 'View Reference 1' })).toBeEnabled());

        now.mockReturnValue(start + 9 * 60 * 1000);
        fireEvent.click(screen.getByRole('button', { name: 'View Reference 1' }));

        await screen.findByRole('dialog', { name: 'References' });
        // The thumbnails' request, then one for the view: the picture and the clip, not the sound.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
          storagePaths: ['user-1/references/frame.png', 'user-1/references/motion.mp4'],
          disposition: 'inline',
        });
      } finally {
        now.mockRestore();
      }
    });

    const outputs = [
      { id: 'm1', mediaKey: 'media-1', url: '/a.png', previewUrl: '/a-still.jpg', mediaKind: 'image' as const },
      { id: 'm2', mediaKey: 'media-2', url: '/b.png', previewUrl: '/b-still.jpg', mediaKind: 'image' as const },
    ] as unknown as NonNullable<Parameters<typeof PostResourceBundlePanel>[0]['mediaItems']>;

    // A preview signs and loads its file as it mounts, so under the plate
    // there is no preview at all, and the outputs' chips keep the Play mark.
    it('covers a mature post\'s previews and output stills until one Show, loading nothing under them', async () => {
      const fetchMock = stubFileUrlFetch();
      // The scoped reference puts the "Resources for" chips on screen.
      const items = normalizePostResourceItems([
        { ...mediaItems[0], scope: { kind: 'media', mediaKeys: ['media-1'] } },
        mediaItems[1],
        mediaItems[2],
      ]);
      const { container } = renderPanel({ ...unlockedWith(items), mediaItems: outputs, coverMedia: true });

      // One plate over the gallery, and the outputs' row; each picture keeps
      // its name and its download under the plate.
      expect(screen.getAllByRole('button', { name: 'Show mature content' })).toHaveLength(2);
      expect(screen.getAllByText('Mature content')).toHaveLength(2);
      expect(screen.getByRole('button', { name: /show items for output 1/i })).toBeInTheDocument();
      expect(container.querySelector('img, video, audio')).toBeNull();
      expect(screen.queryAllByRole('status', { name: /^Loading/ })).toHaveLength(0);
      expect(screen.getByText('Reference 1')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /^Download / })).toHaveLength(3);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getAllByRole('button', { name: 'Show mature content' })[1]);

      expect(screen.queryByRole('button', { name: 'Show mature content' })).toBeNull();
      expect(container.querySelector('img[src="/a-still.jpg"]')).not.toBeNull();
      expect(container.querySelector('img[src="/b-still.jpg"]')).not.toBeNull();
      await waitFor(() => {
        expect(container.querySelector('video')).toHaveAttribute('src', 'https://signed.example.com/user-1/references/motion.mp4#t=0.1');
      });
      expect(container.querySelector('img[src="https://signed.example.com/user-1/references/frame.png"]')).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        storagePaths: mediaItems.map((item) => item.storagePath),
        disposition: 'inline',
      });
    });

    it('lets the outputs\' row reveal its stills when a mature recipe has no preview to press', () => {
      const fetchMock = stubFileUrlFetch();
      const { container } = renderPanel({
        viewerCanAccess: true,
        resourceKinds: ['prompt'],
        mediaItems: outputs,
        coverMedia: true,
        initialResources: {
          promptText: null,
          notesMarkdown: null,
          workflowShareUrl: null,
          attachments: [],
          allowRemix: false,
          items: normalizePostResourceItems([
            { type: 'prompt', title: 'Hero prompt', textContent: 'Hero text', scope: { kind: 'media', mediaKeys: ['media-1'] } },
            { type: 'prompt', title: 'Detail prompt', textContent: 'Detail text', scope: { kind: 'media', mediaKeys: ['media-2'] } },
          ]),
        },
      });

      expect(container.querySelector('img')).toBeNull();
      expect(screen.getByText('Hero text')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Show mature content' }));

      expect(container.querySelector('img[src="/a-still.jpg"]')).not.toBeNull();
      expect(container.querySelector('img[src="/b-still.jpg"]')).not.toBeNull();
      expect(screen.queryByText('Mature content')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('cash checkout', () => {
    const payment = {
      razorpay_payment_id: 'pay-1',
      razorpay_order_id: 'order-1',
      razorpay_signature: 'signature-1',
    };

    function stubCheckoutFetch() {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/order')) {
          return new Response(JSON.stringify({ orderId: 'order-1', amount: 90000, currency: 'USD' }));
        }
        if (url.endsWith('/resource-bundle')) {
          return new Response(JSON.stringify({
            bundle: {
              viewerCanAccess: true,
              viewerIsOwner: false,
              resources: {
                promptText: 'captured prompt',
                notesMarkdown: null,
                workflowShareUrl: null,
                attachments: [],
                allowRemix: false,
              },
            },
          }));
        }
        return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('fetches checkout.js only once Pay is pressed', async () => {
      authState.session = { access_token: 'token-1' };
      const fetchMock = stubCheckoutFetch();
      const opened = vi.fn();
      renderPanel({ isFree: false, priceLabel: '$9.00', priceUsdCents: 900 });

      expect(document.getElementById('post-resource-bundle-razorpay-checkout')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^pay \$9\.00/i }));
      const script = document.getElementById('post-resource-bundle-razorpay-checkout') as HTMLScriptElement | null;
      expect(script?.src).toBe('https://checkout.razorpay.com/v1/checkout.js');

      // The order is created while the script loads; checkout opens once both are in.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/order', expect.anything());
      });
      expect(opened).not.toHaveBeenCalled();
      vi.stubGlobal('Razorpay', class {
        open() { opened(); }
        on() {}
      });
      fireEvent.load(script!);
      await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    });

    /** The sheet takes the payment as soon as it opens. */
    function stubSheetThatPays() {
      vi.stubGlobal('Razorpay', class {
        constructor(private readonly options: { handler: (response: typeof payment) => Promise<void> }) {}
        open() { void this.options.handler(payment); }
        on() {}
      });
    }

    /** Checkout requests, with the recipe read held until `openRecipe` (or locked for good). */
    function stubPaidCheckoutFetch({ recipeOpens }: { recipeOpens: boolean }) {
      let openRecipe: () => void = () => undefined;
      const recipeRead = new Promise<void>((resolve) => {
        openRecipe = resolve;
      });
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/order')) {
          return new Response(JSON.stringify({ orderId: 'order-1', amount: 90000, currency: 'USD' }));
        }
        if (url.endsWith('/resource-bundle')) {
          if (!recipeOpens) {
            return new Response(JSON.stringify({
              bundle: { viewerCanAccess: false, viewerIsOwner: false, resources: null },
            }));
          }
          await recipeRead;
          return new Response(JSON.stringify({
            bundle: {
              viewerCanAccess: true,
              viewerIsOwner: false,
              resources: {
                promptText: 'captured prompt',
                notesMarkdown: null,
                workflowShareUrl: null,
                attachments: [],
                allowRemix: false,
              },
            },
          }));
        }
        return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
      });
      vi.stubGlobal('fetch', fetchMock);
      return { fetchMock, openRecipe: () => openRecipe() };
    }

    function listenForProductEvents() {
      const heard: string[] = [];
      const listener = (event: Event) => heard.push((event as CustomEvent<{ eventName: string }>).detail.eventName);
      window.addEventListener('magicbooklet:product-event', listener);
      return { heard, stop: () => window.removeEventListener('magicbooklet:product-event', listener) };
    }

    it('verifies with the session as it is after the sheet, and reads the settled recipe with it too', async () => {
      authState.session = { access_token: 'token-at-click' };
      const { fetchMock, openRecipe } = stubPaidCheckoutFetch({ recipeOpens: true });
      openRecipe();
      mockVerifyCheckout.mockResolvedValueOnce({ state: 'settled', body: { success: true } });
      stubSheetThatPays();
      renderPanel({ isFree: false, priceLabel: '$9.00', priceUsdCents: 900 });

      fireEvent.click(screen.getByRole('button', { name: /^pay \$9\.00/i }));

      expect(await screen.findByText('captured prompt')).toBeInTheDocument();
      const verifyArguments = mockVerifyCheckout.mock.calls[0][0] as { body: unknown; token: () => Promise<string> };
      expect(verifyArguments.body).toEqual(payment);
      await expect(verifyArguments.token()).resolves.toBe('token-fresh');
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', {
        headers: { Authorization: 'Bearer token-fresh' },
      });
      expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
      expect(screen.queryByText(PAYMENT_RECEIVED)).not.toBeInTheDocument();
    });

    it('a payment still capturing: drops the intent key, says the payment is in, holds the buttons, and opens the recipe from a re-read', async () => {
      authState.session = { access_token: 'token-at-click' };
      authState.credits = 5000;
      authState.marketplaceSpendableCredits = 5000;
      const { fetchMock, openRecipe } = stubPaidCheckoutFetch({ recipeOpens: true });
      let intentKeyDuringVerify: string | null = null;
      mockVerifyCheckout.mockImplementationOnce(async () => {
        intentKeyDuringVerify = window.sessionStorage.getItem(INTENT_KEY);
        return { state: 'pending', body: { code: 'PAYMENT_PENDING' } };
      });
      stubSheetThatPays();
      const funnel = listenForProductEvents();
      try {
        renderPanel({ isFree: false, priceLabel: '$9.00', priceUsdCents: 900 });

        fireEvent.click(screen.getByRole('button', { name: /^pay \$9\.00/i }));

        expect(await screen.findByText(PAYMENT_RECEIVED)).toBeInTheDocument();
        expect(intentKeyDuringVerify).toEqual(expect.any(String));
        expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
        expect(screen.getByRole('button', { name: /^pay \$9\.00/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeDisabled();
        // The re-read carries the session as it is now, not the one from the click.
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', {
            headers: { Authorization: 'Bearer token-fresh' },
          });
        });

        openRecipe();

        expect(await screen.findByText('captured prompt')).toBeInTheDocument();
        expect(screen.queryByText(PAYMENT_RECEIVED)).not.toBeInTheDocument();
        expect(mockRefresh).toHaveBeenCalled();
        expect(funnel.heard).toEqual(['recipe_checkout_started', 'recipe_checkout_succeeded']);
      } finally {
        funnel.stop();
      }
    });

    it('a verify that fails after the sheet took the money never shows the failure or invites another payment', async () => {
      authState.session = { access_token: 'token-at-click' };
      const { fetchMock } = stubPaidCheckoutFetch({ recipeOpens: false });
      mockVerifyCheckout.mockRejectedValueOnce(new Error('Unauthorized'));
      stubSheetThatPays();
      const funnel = listenForProductEvents();
      try {
        renderPanel({ isFree: false, priceLabel: '$9.00', priceUsdCents: 900 });

        fireEvent.click(screen.getByRole('button', { name: /^pay \$9\.00/i }));

        expect(await screen.findByText(PAYMENT_RECEIVED)).toBeInTheDocument();
        expect(screen.queryByText('Unauthorized')).not.toBeInTheDocument();
        expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
        expect(window.sessionStorage.getItem(INTENT_KEY)).toBeNull();
        expect(screen.getByRole('button', { name: /^pay \$9\.00/i })).toBeDisabled();
        expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeDisabled();
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', {
            headers: { Authorization: 'Bearer token-fresh' },
          });
        });
        // A locked re-read keeps the message; nothing turns it into a failure.
        expect(screen.getByText(PAYMENT_RECEIVED)).toBeInTheDocument();
        expect(funnel.heard).toEqual(['recipe_checkout_started']);
      } finally {
        funnel.stop();
      }
    });

    it('starts no wait for a verify that answers after the buyer has left the page', async () => {
      authState.session = { access_token: 'token-at-click' };
      const { fetchMock } = stubPaidCheckoutFetch({ recipeOpens: false });
      let failVerify: (reason: Error) => void = () => undefined;
      mockVerifyCheckout.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        failVerify = reject;
      }));
      stubSheetThatPays();
      const { unmount } = renderPanel({ isFree: false, priceLabel: '$9.00', priceUsdCents: 900 });

      fireEvent.click(screen.getByRole('button', { name: /^pay \$9\.00/i }));
      await waitFor(() => expect(mockVerifyCheckout).toHaveBeenCalledTimes(1));
      unmount();
      failVerify(new Error('Failed to fetch'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockGetSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalledWith('/api/posts/post-1/resource-bundle', expect.anything());
    });
  });
});
