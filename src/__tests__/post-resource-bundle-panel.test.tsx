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

const { mockPush, mockRefresh, mockUpdateCredits, authState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockUpdateCredits: vi.fn(),
  authState: {
    session: null as { access_token: string } | null,
    credits: null as number | null,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
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
    authState.session = null;
    authState.credits = null;
    vi.unstubAllGlobals();
  });

  it('keeps locked prompt-only unlocks compact with one open action', () => {
    renderPanel({
      isFree: false,
      priceLabel: '$9.00',
      priceUsdCents: 900,
    });

    expect(screen.getByRole('button', { name: /pay \$9\.00 with razorpay/i })).toBeInTheDocument();
    expect(screen.getByText(/the prompt text stays locked until this unlock is opened/i)).toBeInTheDocument();
    expect(screen.queryByText(/labels and file types can be shown publicly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });

  it('presents free public resources as a visible creation recipe', () => {
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

    expect(screen.getAllByText(/creation recipe/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/prompt, notes, references, and files are available here as a creation recipe/i)).toBeInTheDocument();
    expect(screen.getByText(/available now/i)).toBeInTheDocument();
    expect(screen.getByText('Public recipe prompt')).toBeInTheDocument();
    expect(screen.getByText('Public recipe notes')).toBeInTheDocument();
    expect(screen.getByText('Image input')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open free unlock/i })).toBeNull();
    expect(screen.queryByText(/buyer trust/i)).toBeNull();
    expect(screen.queryByText(/digital unlocks are final sale/i)).toBeNull();
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
    expect(screen.getByText(/owner preview\. buyers must unlock before seeing this/i)).toBeInTheDocument();
  });

  it('shows buyer trust terms without exposing locked content', () => {
    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
      priceNote: 'Charged in INR for buyers in India.',
    });

    expect(screen.getByRole('button', { name: /pay ₹189 with razorpay/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use 900 credits/i })).toBeInTheDocument();
    expect(screen.getByText(/credit cost: 900 credits/i)).toBeInTheDocument();
    expect(screen.getByText(/digital unlocks are final sale/i)).toBeInTheDocument();
    expect(screen.getByText(/do not resell, redistribute, or claim the raw bundle as your own/i)).toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });

  it('shows grouped item counts before access and grouped resources after access', () => {
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

    expect(screen.getByText(/includes 2 workflows, 2 reference images/i)).toBeInTheDocument();
    expect(screen.getByText('Workflows')).toBeInTheDocument();
    expect(screen.getByText('Reference images')).toBeInTheDocument();
    expect(screen.getByText('Main workflow')).toBeInTheDocument();
    expect(screen.getByText('Style frame')).toBeInTheDocument();
  });

  it('shows section counts while locked and groups unlocked resources by section', () => {
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

    expect(screen.getByText(/includes 1 section, 1 prompt, 1 reference image/i)).toBeInTheDocument();
    expect(screen.getByText('Full post resources')).toBeInTheDocument();
    expect(screen.getByText('Hook')).toBeInTheDocument();
    expect(screen.getByText('Hook prompt')).toBeInTheDocument();
    expect(screen.getByText('Global style reference')).toBeInTheDocument();
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
});
