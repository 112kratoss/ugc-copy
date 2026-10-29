import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import { requestConfirmation } from '@/components/feedback-state';
import {
  normalizePostResourceItems,
  normalizePostResourceSections,
  type PostResourceBundleLockedPreview,
  type PostResourceItem,
} from '@/lib/post-resource-bundles';

/**
 * The buyer's side of a recipe on the post page, after the recipe audit of
 * 2026-10-27 (B-F3, B-F5, B-F8, B-F9, B-F10, B-F16, B-F17, B-F18, S3).
 */

const { mockRouter, authState } = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), refresh: vi.fn() },
  authState: {
    session: { access_token: 'token-1' } as { access_token: string } | null,
    credits: 1000 as number | null,
    marketplaceSpendableCredits: 1000 as number | null,
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('@/components/feedback-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/feedback-state')>()),
  requestConfirmation: vi.fn(async () => true),
}));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    credits: authState.credits,
    marketplaceSpendableCredits: authState.marketplaceSpendableCredits,
    updateCredits: vi.fn(),
  }),
}));

const referenceOnlyPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['files'],
  attachmentPreviews: [],
  itemCounts: { reference_image: 1 },
  itemPreviews: [{ type: 'reference_image', title: 'Reference media', role: 'style_reference', remixUse: 'reference_only' }],
  cardPreviews: [{ sectionId: 'refs', publicTitle: 'Reference media', resourceType: 'reference_image', scope: { kind: 'all' }, itemCount: 1, hasRemix: false }],
  hasPrompt: false,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: false,
  updatedAt: '2026-10-20T10:00:00.000Z',
} as PostResourceBundleLockedPreview;

function renderPanel(overrides: Partial<Parameters<typeof PostResourceBundlePanel>[0]> = {}) {
  return render(
    <PostResourceBundlePanel
      postId="post-1"
      title="Launch hook recipe"
      summary="The exact setup behind this launch frame."
      previewText=""
      priceLabel="$2.50"
      priceUsdCents={250}
      priceNote={null}
      isFree={false}
      viewerCanAccess={false}
      viewerIsOwner={false}
      resourceKinds={['files']}
      lockedPreview={referenceOnlyPreview}
      salesCount={3}
      freeUnlockCount={0}
      initialResources={null}
      {...overrides}
    />
  );
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const unlockedBundle = {
  viewerCanAccess: true,
  viewerIsOwner: false,
  resources: {
    promptText: null,
    notesMarkdown: null,
    workflowShareUrl: null,
    attachments: [],
    allowRemix: true,
    items: normalizePostResourceItems([
      { type: 'prompt', role: 'primary', title: 'Hook prompt', textContent: 'A slow dolly over the bottle.' },
    ]),
  },
};

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.refresh.mockClear();
  vi.mocked(requestConfirmation).mockClear();
  authState.session = { access_token: 'token-1' };
  authState.credits = 1000;
  authState.marketplaceSpendableCredits = 1000;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the locked recipe', () => {
  // B-F5: every recipe but a lone prompt promised all five kinds.
  it('promises nothing the recipe does not hold', () => {
    renderPanel();

    expect(screen.queryByText(/workflow links/i)).toBeNull();
    expect(screen.queryByText(/remix access/i)).toBeNull();
  });

  // B-F16: "Reference media · reference image · 1 item".
  it("does not repeat a card's title in the line after it", () => {
    renderPanel();

    const card = screen.getByText('Reference media').parentElement as HTMLElement;
    expect(card.textContent).toBe('Reference media');
  });

  // B-F3: a remix sold with the recipe was never named before buying.
  it('names the remix that comes with it', () => {
    renderPanel({ remixIncluded: true });

    expect(screen.getByText('Remix included')).toBeInTheDocument();
  });

  it('says nothing of a remix the post does not offer', () => {
    renderPanel({ remixIncluded: false });

    expect(screen.queryByText(/remix included/i)).toBeNull();
  });

  // B-F10: "Get resources — Free" under "Get the full recipe free…", and the
  // card button named the payment provider.
  it('asks in recipe words, and names no payment provider', () => {
    const paid = renderPanel();

    expect(screen.getByRole('button', { name: /^pay \$2\.50/i })).toBeInTheDocument();
    expect(screen.queryByText(/razorpay/i)).toBeNull();
    paid.unmount();

    renderPanel({ isFree: true, priceUsdCents: 0, priceLabel: '$0.00' });
    expect(screen.getByRole('button', { name: 'Get free recipe' })).toBeInTheDocument();
    expect(screen.queryByText(/get resources/i)).toBeNull();
  });

  // B-F8: "Buy credits" went to a bare /pricing with no way back.
  it('sends a buyer short of credits to Pricing with the way back to this recipe', () => {
    authState.marketplaceSpendableCredits = 100;
    renderPanel({ returnPath: '/showcase/post-1?from=home' });

    expect(screen.getByRole('link', { name: /buy credits/i })).toHaveAttribute(
      'href',
      `/pricing?returnTo=${encodeURIComponent('/showcase/post-1?from=home#recipe')}`,
    );
  });
});

describe('unlocking with credits at the price the buyer confirmed (S3)', () => {
  it('asks in the glossary words and sends the price it asked about', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.endsWith('/unlock-with-credits')
        ? jsonResponse({ success: true, credits: 750, marketplaceSpendableCredits: 750 })
        : jsonResponse({ success: true, bundle: unlockedBundle })
    ));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /use 250 credits/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/posts/post-1/resource-bundle/unlock-with-credits',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedPriceCredits: 250 }) }),
    ));
    expect(requestConfirmation).toHaveBeenCalledWith({
      title: 'Unlock this recipe?',
      message: '250 credits will come off your balance.',
      confirmLabel: 'Unlock for 250 credits',
    });
  });

  it('charges nothing when the price moved, shows the new one, and asks again at it', async () => {
    let unlockCalls = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      void _init;
      if (url.endsWith('/unlock-with-credits')) {
        unlockCalls += 1;
        return unlockCalls === 1
          ? jsonResponse({ success: false, code: 'RESOURCE_PRICE_CHANGED', error: 'The price changed to 300 credits.', priceCredits: 300 }, 409)
          : jsonResponse({ success: true, credits: 700, marketplaceSpendableCredits: 700 });
      }
      return jsonResponse({ success: true, bundle: unlockedBundle });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /use 250 credits/i }));

    expect(await screen.findByText('The price changed to 300 credits.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use 300 credits/i })).toBeInTheDocument();
    expect(screen.queryByText('Recipe unlocked')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /use 300 credits/i }));

    await waitFor(() => expect(unlockCalls).toBe(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/posts/post-1/resource-bundle', expect.anything());
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/unlock-with-credits')).map(([, init]) => init?.body))
      .toEqual([JSON.stringify({ expectedPriceCredits: 250 }), JSON.stringify({ expectedPriceCredits: 300 })]);
    expect(requestConfirmation).toHaveBeenLastCalledWith(expect.objectContaining({ confirmLabel: 'Unlock for 300 credits' }));
  });
});

describe('after unlocking', () => {
  // B-F9: nothing said where a bought recipe is kept.
  it('says the recipe is unlocked and where it is kept', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.endsWith('/unlock-free')
        ? jsonResponse({ success: true })
        : jsonResponse({ success: true, bundle: unlockedBundle })
    )));
    renderPanel({ isFree: true, priceUsdCents: 0, priceLabel: '$0.00' });

    fireEvent.click(screen.getByRole('button', { name: 'Get free recipe' }));

    expect(await screen.findByText('Recipe unlocked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unlocked recipes' })).toHaveAttribute('href', '/creations?view=unlocks');
    expect(screen.getByText('A slow dolly over the bottle.')).toBeInTheDocument();
  });

  it('says so when a host unlocked it on the way in', () => {
    renderPanel({ viewerCanAccess: true, initialResources: unlockedBundle.resources, announceUnlock: true });

    expect(screen.getByText('Recipe unlocked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unlocked recipes' })).toBeInTheDocument();
  });

  // B-F3: after buying, the panel said nothing of the remix that came with it.
  it('points at the remix that came with it', () => {
    renderPanel({ viewerCanAccess: true, initialResources: unlockedBundle.resources, remixIncluded: true });

    expect(screen.getByText('Remix included — use Remix on this post')).toBeInTheDocument();
  });

  it('calls a newer version an update to the recipe', () => {
    renderPanel({
      viewerCanAccess: true,
      initialResources: unlockedBundle.resources,
      purchasedRevision: {
        revisionNumber: 1,
        purchasedAt: '2026-10-01T00:00:00.000Z',
        title: 'Launch hook recipe',
        summary: '',
        previewText: '',
        accessMode: 'paid',
        priceUsdCents: 250,
        resources: unlockedBundle.resources,
      },
    });

    expect(screen.getByText('The creator has updated this recipe since you bought it. You can read either version.')).toBeInTheDocument();
  });
});

describe('the unlocked contents (B-F17, B-F18)', () => {
  const sections = normalizePostResourceSections([
    { id: 'look', title: 'The look', kind: 'scene' },
    { id: 'setup', title: 'Model settings', kind: 'scene' },
    { id: 'links', title: 'Links', kind: 'scene' },
  ]);
  const items: PostResourceItem[] = normalizePostResourceItems([
    { type: 'prompt', role: 'primary', title: 'Look prompt', textContent: 'Warm rim light.', sectionId: 'look' },
    { type: 'settings', role: 'supporting', title: 'Settings', textContent: 'Saved generation setup\nModel: Kling 2.5\nAspect ratio: 9:16', sectionId: 'setup' },
    { type: 'workflow', role: 'primary', title: 'Comfy graph', externalUrl: 'https://example.com/workflow', sectionId: 'links' },
    { type: 'remix_link', role: 'supporting', title: 'Remix board', externalUrl: 'https://example.com/remix', sectionId: 'links' },
    { type: 'external_link', role: 'supporting', title: 'Moodboard', externalUrl: 'https://example.com/board', sectionId: 'links' },
    { type: 'reference_image', role: 'style_reference', title: 'Input 1', externalUrl: 'https://example.com/input.png' },
  ], { sections });

  function renderUnlocked() {
    return renderPanel({
      viewerCanAccess: true,
      initialResources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        sections,
        items,
      },
    });
  }

  it('shows saved settings as keys and values, not a block of text', () => {
    renderUnlocked();

    // A card left under the form name "Model settings" reads as what it holds.
    const setup = screen.getByRole('region', { name: 'Generation setup' });
    expect(within(setup).getByText('Aspect ratio')).toBeInTheDocument();
    expect(within(setup).getByText('9:16')).toBeInTheDocument();
    expect(screen.queryByText(/Saved generation setup/)).toBeNull();
  });

  it('names each link by what it opens', () => {
    renderUnlocked();

    expect(screen.getByRole('link', { name: 'Open workflow' })).toHaveAttribute('href', 'https://example.com/workflow');
    expect(screen.getByRole('link', { name: 'Open remix' })).toHaveAttribute('href', 'https://example.com/remix');
    expect(screen.getAllByRole('link', { name: 'Open link' }).map((link) => link.getAttribute('href')))
      .toContain('https://example.com/board');
  });

  // The creator's cards in their order; the picture they put in no card
  // comes straight after the card holding the prompt, which names it.
  it("keeps the creator's order, with their references after the prompt", () => {
    renderUnlocked();

    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['The look', 'References', 'Generation setup', 'Links']);
    expect(screen.queryByText('More from this post')).toBeNull();
  });

  it('says Copied on the button that copied', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderUnlocked();

    const copyButtons = screen.getAllByRole('button', { name: /^copy/i });
    fireEvent.click(copyButtons[0]);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Warm rim light.'));
    expect(await screen.findByRole('button', { name: /copied/i })).toBe(copyButtons[0]);
    expect(screen.queryByText(/copied to clipboard/i)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(copyButtons[0]).toHaveTextContent('Copy');
  });
});
