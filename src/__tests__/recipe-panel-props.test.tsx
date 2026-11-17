import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import { buildRecipePanelProps, getRecipeRemixOffer, type RecipePanelSource } from '@/app/showcase/[id]/recipe-panel-props';
import { normalizePostResourceItems, type PostResourceBundleLockedPreview } from '@/lib/post-resource-bundles';

// Owner, 2026-11-17, asked "Remix can't work on posts made outside the app. Hide it there for now?":
// "Yes, hide it". The post page and the reel name the Remix a recipe comes with ("Remix included"
// before it is had, "Remix included — use Remix on this post" after) and offer it ("Remix · Free",
// or open once the recipe is had), from the post's own read. A post with no creation has nothing to
// remix: the remix route refuses it. Here the read is one that still offers a Remix on such a post
// (a page drawn before the server stopped offering one), and the page offers and names none.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'token-1' },
    credits: 100,
    marketplaceSpendableCredits: 100,
    updateCredits: vi.fn(),
  }),
}));

const lockedPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['files', 'remix'],
  attachmentPreviews: [],
  itemCounts: { reference_image: 1 },
  itemPreviews: [{ type: 'reference_image', title: 'Reference image', role: 'other', remixUse: 'reference_only' }],
  hasPrompt: false,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: true,
  updatedAt: '2026-10-01T10:00:00.000Z',
};

/** A free recipe of one reference picture, its stored switch on, as a visitor's read told it. */
const bundle = {
  title: 'The recipe',
  summary: 'The reference behind this still.',
  previewText: '',
  accessMode: 'free',
  priceUsdCents: 0,
  priceQuote: { formatted: 'Free', note: null },
  viewerCanAccess: false,
  viewerIsOwner: false,
  allowRemix: true,
  resourceKinds: ['files', 'remix'],
  lockedPreview,
  salesCount: 0,
  freeUnlockCount: 0,
  resources: null,
  purchasedRevision: null,
} satisfies RecipePanelSource & { allowRemix: boolean };

/** The same recipe once the reader has it. */
const boughtBundle = {
  ...bundle,
  viewerCanAccess: true,
  resources: {
    promptText: null,
    notesMarkdown: null,
    workflowShareUrl: null,
    workflowSnapshot: null,
    attachments: [],
    allowRemix: true,
    items: normalizePostResourceItems([
      { type: 'reference_image', title: 'Reference picture', storagePath: 'creator-1/reference.png', contentType: 'image/png' },
    ]),
  },
} satisfies RecipePanelSource & { allowRemix: boolean };

/** The post's Remix as that read told it: locked behind the recipe, or open to whoever has it. */
const lockedRemix = { canRemix: false, remixCapability: 'unlock_required', remixTarget: 'image' } as const;
const openRemix = { canRemix: true, remixCapability: 'public', remixTarget: 'image' } as const;

// The picture's preview is signed as it is drawn: answered with none.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderRecipe(source: RecipePanelSource, remixIncluded: boolean) {
  return render(
    <PostResourceBundlePanel
      {...buildRecipePanelProps(source, { postId: 'post-1', mediaItems: [], remixIncluded })}
    />,
  );
}

describe('the recipe of a post with no creation', () => {
  it('comes with no Remix: none is offered, before or after it is had', () => {
    expect(getRecipeRemixOffer({ generationId: null, ...lockedRemix, bundle }))
      .toEqual({ remixIncluded: false, recipeRemix: null });
    expect(getRecipeRemixOffer({ generationId: null, ...openRemix, bundle: boughtBundle }))
      .toEqual({ remixIncluded: false, recipeRemix: null });
  });

  it('says nothing of a Remix, locked or had', () => {
    const locked = renderRecipe(bundle, getRecipeRemixOffer({ generationId: null, ...lockedRemix, bundle }).remixIncluded);
    expect(screen.getByRole('button', { name: 'Get free recipe' })).toBeInTheDocument();
    expect(screen.queryByText(/remix included/i)).toBeNull();
    locked.unmount();

    renderRecipe(boughtBundle, getRecipeRemixOffer({ generationId: null, ...openRemix, bundle: boughtBundle }).remixIncluded);
    expect(screen.getByRole('heading', { level: 3, name: 'References' })).toBeInTheDocument();
    expect(screen.queryByText(/remix included/i)).toBeNull();
    expect(screen.queryByText(/use remix on this post/i)).toBeNull();
  });

  it('leaves a creation’s recipe naming and offering the Remix it comes with', () => {
    expect(getRecipeRemixOffer({ generationId: 'generation-1', ...lockedRemix, bundle }))
      .toEqual({ remixIncluded: true, recipeRemix: { access: 'free', priceLabel: 'Free' } });
    renderRecipe(boughtBundle, getRecipeRemixOffer({ generationId: 'generation-1', ...openRemix, bundle: boughtBundle }).remixIncluded);
    expect(screen.getByText('Remix included — use Remix on this post')).toBeInTheDocument();
  });
});
