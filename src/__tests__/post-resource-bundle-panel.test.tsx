import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import {
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PostResourceBundleLockedPreview,
  type PostResourceItem,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

const { mockPush, mockRefresh, mockRouter, mockUpdateCredits, mockVerifyCheckout, authState } = vi.hoisted(() => {
  const push = vi.fn();
  const refresh = vi.fn();
  return {
    mockPush: push,
    mockRefresh: refresh,
    mockRouter: { push, refresh },
    mockUpdateCredits: vi.fn(),
    mockVerifyCheckout: vi.fn(),
    authState: {
      session: null as { access_token: string } | null,
      credits: null as number | null,
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
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
    updateCredits: mockUpdateCredits,
  }),
}));

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
    authState.session = null;
    authState.credits = null;
    vi.unstubAllGlobals();
    document.getElementById('post-resource-bundle-razorpay-checkout')?.remove();
  });

  it('keeps locked prompt-only unlocks compact with one open action', () => {
    renderPanel({
      isFree: false,
      priceLabel: '$9.00',
      priceUsdCents: 900,
    });

    expect(screen.getByRole('button', { name: /pay \$9\.00 with razorpay/i })).toBeInTheDocument();
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
    // with just the status chip saying what it is.
    expect(screen.getByText('Free recipe')).toBeInTheDocument();
    expect(screen.getByText('Public recipe prompt')).toBeInTheDocument();
    expect(screen.getByText('Public recipe notes')).toBeInTheDocument();
    expect(screen.getByText('Image input')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /get resources — free/i })).toBeNull();
    expect(screen.queryByText(/buyer trust/i)).toBeNull();
    expect(screen.queryByText(/digital recipes are final sale/i)).toBeNull();
  });

  it('offers one-click access for a gated free recipe without checkout choices', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: /get resources — free/i })).toBeInTheDocument();
    expect(screen.getByText(/get the full recipe free with one click/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pay .* with razorpay/i })).toBeNull();
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

    expect(screen.getByRole('button', { name: /pay ₹189 with razorpay/i })).toBeInTheDocument();
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

    expect(screen.getByText(/includes 2 workflows, 2 reference images/i)).toBeInTheDocument();
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

    expect(screen.queryByText(/includes 2 workflows, 2 reference images/i)).not.toBeInTheDocument();
    expect(screen.getByText('Workflows')).toBeInTheDocument();
    expect(screen.getByText('Reference images')).toBeInTheDocument();
    expect(screen.getByText('Main workflow')).toBeInTheDocument();
    expect(screen.getByText('Style frame')).toBeInTheDocument();
  });

  it('shows section counts while locked and groups unlocked resources by section', () => {
    const locked = renderPanel({
      resourceKinds: ['prompt', 'files'],
      lockedPreview: sectionedPreview,
      initialResources: null,
    });

    expect(screen.getByText(/includes 1 section, 1 prompt, 1 reference image/i)).toBeInTheDocument();
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

    expect(screen.getByText('Full post resources')).toBeInTheDocument();
    expect(screen.getByText('Hook')).toBeInTheDocument();
    expect(screen.getByText('Hook prompt')).toBeInTheDocument();
    expect(screen.getByText('Global style reference')).toBeInTheDocument();
  });

  it('renders only explicit public resource cards while a bundle is locked', () => {
    renderPanel({
      resourceKinds: ['files', 'remix'],
      lockedPreview: explicitCardPreview,
    });

    expect(screen.getByText('Hook video references')).toBeInTheDocument();
    expect(screen.getByText('reference videos')).toBeInTheDocument();
    expect(screen.getByText('Applies to 2 selected outputs')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
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

      expect(screen.getByRole('button', { name: /all resources/i })).toBeInTheDocument();
      expect(screen.getByText('Hook video references')).toBeInTheDocument();

      // The card is scoped to media-1 and media-2, so a third output hides it.
      fireEvent.click(screen.getByRole('button', { name: /show resources for output 1/i }));
      expect(screen.getByText('Hook video references')).toBeInTheDocument();
    });

    it('stays hidden when nothing is scoped to a specific output', () => {
      renderPanel({ mediaItems: scopedMediaItems });

      expect(screen.queryByRole('button', { name: /all resources/i })).not.toBeInTheDocument();
    });

    it('stays hidden when the post has a single output', () => {
      renderPanel({
        resourceKinds: ['files', 'remix'],
        lockedPreview: explicitCardPreview,
        mediaItems: scopedMediaItems.slice(0, 1),
      });

      expect(screen.queryByRole('button', { name: /all resources/i })).not.toBeInTheDocument();
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

      fireEvent.click(screen.getByRole('button', { name: /show resources for output 1/i }));
      expect(screen.queryByText('Hook video references')).not.toBeInTheDocument();
      expect(screen.getByText(/no resources apply to this output/i)).toBeInTheDocument();
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

      fireEvent.click(screen.getByRole('button', { name: /show resources for output 2/i }));
      expect(screen.queryByText('Hero output')).not.toBeInTheDocument();
      expect(screen.getByText(/no resources apply to this output/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /show resources for output 1/i }));
      expect(screen.getByText('Hero output')).toBeInTheDocument();
      expect(screen.queryByText(/no resources apply to this output/i)).not.toBeInTheDocument();
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

      fireEvent.click(screen.getByRole('button', { name: /show resources for output 1/i }));
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

      fireEvent.click(screen.getByRole('button', { name: /show resources for output 2/i }));
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

      expect(screen.getByRole('button', { name: /show resources for output 3/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /the version you unlocked/i }));

      expect(screen.queryByRole('button', { name: /show resources for output 3/i })).not.toBeInTheDocument();
      expect(screen.getByText('Purchased output')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /show resources for output 2/i }));
      expect(screen.getByText(/no resources apply to this output/i)).toBeInTheDocument();
    });
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

    expect(screen.getByText('Hero output')).toBeInTheDocument();
    expect(screen.getByText('Full post resources')).toBeInTheDocument();
    expect(screen.getByText('Reference video')).toBeInTheDocument();
    expect(screen.getByText('Reference audio')).toBeInTheDocument();
    expect(screen.getByText('Remix link')).toBeInTheDocument();
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

    expect(screen.queryByRole('button', { name: /pay .* with razorpay/i })).toBeNull();
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
          Authorization: 'Bearer token-1',
        },
      }));
    });
    expect(mockUpdateCredits).toHaveBeenCalledWith(100);
    expect(await screen.findByText('revealed prompt')).toBeInTheDocument();
  });

  it('shows a credit top-up path when the viewer has insufficient credits', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 120;

    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
    });

    expect(screen.getByText(/120 credits available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /buy credits/i })).toHaveAttribute('href', '/pricing');
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

    fireEvent.click(screen.getByRole('button', { name: /pay ₹189 with razorpay/i }));

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
      expect(container.querySelector('video')).toHaveAttribute('src', 'https://signed.example.com/user-1/references/motion.mp4');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/posts/post-1/resource-bundle/file-url');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        storagePaths: mediaItems.map((item) => item.storagePath),
        disposition: 'inline',
      });
    });

    it('signs previews one by one on the buyer library route, which answers one file a call', async () => {
      const fetchMock = stubFileUrlFetch();
      renderPanel({
        ...unlockedWith(mediaItems.slice(0, 2)),
        fileUrlEndpoint: '/api/me/unlocks/unlock-1/file-url',
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
        ['/api/me/unlocks/unlock-1/file-url', { storagePath: 'user-1/references/frame.png', disposition: 'inline' }],
        ['/api/me/unlocks/unlock-1/file-url', { storagePath: 'user-1/references/motion.mp4', disposition: 'inline' }],
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
        renderPanel(unlockedWith(mediaItems.slice(0, 1)));

        fireEvent.click(screen.getByRole('button', { name: 'Open file' }));
        await waitFor(() => {
          expect(open).toHaveBeenCalledWith(
            'https://signed.example.com/inline/user-1/references/frame.png',
            '_blank',
            'noopener,noreferrer',
          );
        });

        fireEvent.click(screen.getByRole('button', { name: 'Download' }));
        await waitFor(() => {
          expect(saved).toEqual([{
            href: 'https://signed.example.com/attachment/user-1/references/frame.png',
            download: 'Reference 1.png',
          }]);
        });
      } finally {
        open.mockRestore();
        click.mockRestore();
      }
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
      fireEvent.click(screen.getByRole('button', { name: /pay \$9\.00 with razorpay/i }));
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

    it('looks once more at a payment still capturing when the buyer comes back to the tab', async () => {
      authState.session = { access_token: 'token-1' };
      stubCheckoutFetch();
      mockVerifyCheckout
        .mockResolvedValueOnce({ state: 'pending', body: { code: 'PAYMENT_PENDING' } })
        .mockResolvedValueOnce({ state: 'settled', body: { success: true } });
      vi.stubGlobal('Razorpay', class {
        constructor(private readonly options: { handler: (response: typeof payment) => Promise<void> }) {}
        open() { void this.options.handler(payment); }
        on() {}
      });
      renderPanel({ isFree: false, priceLabel: '$9.00', priceUsdCents: 900 });

      fireEvent.click(screen.getByRole('button', { name: /pay \$9\.00 with razorpay/i }));
      expect(await screen.findByText(/payment received and waiting for capture/i)).toBeInTheDocument();
      expect(mockVerifyCheckout).toHaveBeenCalledTimes(1);

      fireEvent.focus(window);
      expect(await screen.findByText('captured prompt')).toBeInTheDocument();
      expect(mockVerifyCheckout).toHaveBeenCalledTimes(2);
      expect(mockVerifyCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ body: payment, maxAttempts: 1 }));
      expect(screen.queryByText(/payment received and waiting for capture/i)).toBeNull();

      // Once: a later return to the tab asks nothing more.
      fireEvent.focus(window);
      expect(mockVerifyCheckout).toHaveBeenCalledTimes(2);
    });
  });
});
