import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplacePage, { metadata, revalidate } from '@/app/marketplace/page';
import { PUBLIC_PAGE_REVALIDATE_SECONDS } from '@/lib/public-page-cache';

const getMarketplaceResourceListMock = vi.fn();
// The page is one cached render for everyone (ISR): a read of the request's
// headers, its cookies or the server's session would make it render per
// request again, and could put one viewer's list in front of everyone.
const requestTimeRead = vi.hoisted(() => vi.fn((what: string) => {
  throw new Error(`The marketplace read ${what}: it must stay one cached render for everyone`);
}));
const sourceToolCatalog = vi.hoisted(() => [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
  { slug: 'runway', label: 'Runway', models: [], supportedMediaKinds: ['image', 'video'] },
]);
// The address the page is open at, as the browser's router reads it.
const address = vi.hoisted(() => ({ search: '' }));
const authState = vi.hoisted(() => ({
  session: null as { access_token: string } | null,
  user: null as { id: string } | null,
}));

vi.mock('next/headers', () => ({
  headers: () => requestTimeRead('the request headers'),
  cookies: () => requestTimeRead('the request cookies'),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(address.search),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceResourceList: (...args: unknown[]) => getMarketplaceResourceListMock(...args),
}));

vi.mock('@/lib/source-tools-server', () => ({
  listSourceToolsCatalog: () => Promise.resolve(sourceToolCatalog),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => requestTimeRead("the viewer's session"),
}));

vi.mock('@/components/AuthProvider', () => ({
  // `OptionalAuth`: the page resolves the session in the browser.
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ session: authState.session, user: authState.user }),
}));

/** The list API as the browser meets it: one answer for every listing, unless a test gives one. */
function answerListing(answer: (url: URL, init?: RequestInit) => { status?: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://magicbooklet.test');
    if (url.pathname === '/api/marketplace/resources') {
      const { status = 200, body } = answer(url, init);
      return { ok: status < 400, status, json: async () => body } as Response;
    }
    // `/api/me/unlocked-recipes` and anything else: nothing to report.
    return { ok: true, status: 200, json: async () => ({ bundleIds: [] }) } as Response;
  }));
}

function listingReads() {
  return vi.mocked(fetch).mock.calls
    .filter(([input]) => String(input).startsWith('/api/marketplace/resources'))
    .map(([input, init]) => ({
      query: Object.fromEntries(new URL(String(input), 'https://magicbooklet.test').searchParams),
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
    }));
}

async function openPage() {
  await act(async () => {
    render(await MarketplacePage());
  });
}

describe('MarketplacePage', () => {
  beforeEach(() => {
    getMarketplaceResourceListMock.mockReset();
    getMarketplaceResourceListMock.mockResolvedValue({ items: [] });
    requestTimeRead.mockClear();
    routerMock.push.mockReset();
    address.search = '';
    authState.session = null;
    authState.user = null;
    // By default the browser's read fails, and the plain address keeps the page's list.
    answerListing(() => ({ status: 503, body: { error: 'Not answered here' } }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is cached for everyone: the plain storefront, read in no country, and never the request', async () => {
    await openPage();

    expect(revalidate).toBe(PUBLIC_PAGE_REVALIDATE_SECONDS);
    expect(requestTimeRead).not.toHaveBeenCalled();
    expect(getMarketplaceResourceListMock).toHaveBeenCalledTimes(1);
    const [options] = getMarketplaceResourceListMock.mock.calls[0];
    expect(options).toEqual({
      filter: 'all',
      resource: 'all',
      tool: null,
      q: null,
      sort: 'recent',
      limit: 4,
      offset: 0,
    });
    expect(screen.getByRole('heading', {
      name: /buy the reusable parts behind community posts/i,
    })).toBeInTheDocument();
  });

  // CI builds against a placeholder database, where the prerender's read fails.
  it('goes out with no first page from a build that cannot read one, and the browser reads it', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    getMarketplaceResourceListMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.supabase.co'));
    let answer!: (body: unknown) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
      String(input).startsWith('/api/marketplace/resources')
        ? new Promise<Response>((resolve) => {
            answer = (body) => resolve({ ok: true, status: 200, json: async () => body } as Response);
          })
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ bundleIds: [] }) } as Response)
    )));

    try {
      await openPage();

      // Loading, never a cached "No recipes yet".
      expect(screen.getByLabelText('Loading marketplace recipes')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();
      await act(async () => {
        answer({
          items: [createMarketplaceResourceItem({ title: 'Read in the browser', post: null })],
          pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 },
        });
      });
      expect(await screen.findByText('Read in the browser')).toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails the render outside a build, so the cache keeps its last good page', async () => {
    getMarketplaceResourceListMock.mockRejectedValue(new Error('connection reset'));

    await expect(MarketplacePage()).rejects.toThrow('connection reset');
  });

  it('names /marketplace as the canonical of every address, a filtered one included', () => {
    expect(metadata.alternates?.canonical).toBe('/marketplace');
    expect(metadata.title).toBe('Recipe Marketplace');
    expect(metadata.robots).toBeUndefined();
  });

  // The first page was quoted in USD for everyone while "Load more" and the
  // post a card opens were quoted in the visitor's currency. The cached page is
  // quoted in no country; the browser reads the same page in the visitor's.
  it("quotes the first page in the visitor's currency once the browser has read it, with no session", async () => {
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [createMarketplaceResourceItem({
        title: 'Paid recipe',
        accessMode: 'paid',
        priceUsdCents: 900,
        priceQuote: { currency: 'USD', amountSubunits: 900, formatted: '$9.00', note: null },
      })],
      pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 },
    });
    answerListing(() => ({
      body: {
        items: [createMarketplaceResourceItem({
          title: 'Paid recipe',
          accessMode: 'paid',
          priceUsdCents: 900,
          priceQuote: { currency: 'INR', amountSubunits: 75000, formatted: '₹750.00', note: null },
        })],
        pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 },
      },
    }));

    await openPage();

    expect(await screen.findByRole('link', { name: /Unlock for ₹750\.00 · 900 credits/ })).toBeInTheDocument();
    expect(listingReads()).toEqual([{
      query: { sort: 'recent', offset: '0', limit: '4' },
      authorization: null,
    }]);
  });

  // The storefront was the one list that kept showing a creator the viewer
  // blocked, or who blocked them; each card then opened a 404. The cached page
  // is everyone's, so the browser asks the list API, which filters for the
  // session it is sent.
  it("takes a signed-in viewer's blocked creators off the first page, and no one's for a visitor", async () => {
    const page = {
      items: [
        createMarketplaceResourceItem({ id: 'bundle-kept', title: 'Kept recipe', post: null }),
        createMarketplaceResourceItem({
          id: 'bundle-blocked',
          postId: 'post-blocked',
          title: 'Blocked recipe',
          post: null,
          seller: { id: 'creator-blocked', username: 'blocked', name: 'Blocked', avatar: null },
        }),
      ],
      pageInfo: { hasMore: true, nextOffset: 3, offset: 0, limit: 3 },
    };
    getMarketplaceResourceListMock.mockResolvedValue(page);
    answerListing((_url, init) => ({
      body: (init?.headers as Record<string, string> | undefined)?.Authorization
        ? { ...page, items: page.items.filter((item) => item.id !== 'bundle-blocked') }
        : page,
    }));
    authState.session = { access_token: 'viewer-token' };
    authState.user = { id: 'viewer-1' };

    await openPage();

    await waitFor(() => expect(screen.queryByText('Blocked recipe')).not.toBeInTheDocument());
    expect(screen.getByText('Kept recipe')).toBeInTheDocument();
    expect(listingReads()).toEqual([{
      query: { sort: 'recent', offset: '0', limit: '4' },
      authorization: 'Bearer viewer-token',
    }]);
    // The next page still starts where the unfiltered one ended.
    expect(screen.getByRole('button', { name: /load more recipes/i })).toBeInTheDocument();
  });

  it("draws a filtered address's own listing, never the cached one while it loads", async () => {
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [createMarketplaceResourceItem({ title: 'Newest free recipe', post: null })],
      pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 },
    });
    let answer!: (body: unknown) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
      String(input).startsWith('/api/marketplace/resources')
        ? new Promise<Response>((resolve) => {
            answer = (body) => resolve({ ok: true, status: 200, json: async () => body } as Response);
          })
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ bundleIds: [] }) } as Response)
    )));
    address.search = '?access=paid&sort=top-sales';

    await openPage();

    expect(screen.getByLabelText('Loading marketplace recipes')).toBeInTheDocument();
    expect(screen.queryByText('Newest free recipe')).not.toBeInTheDocument();
    expect(listingReads()).toEqual([{
      query: { access: 'paid', sort: 'top-sales', offset: '0', limit: '4' },
      authorization: null,
    }]);
    expect(screen.getByRole('link', { name: 'Paid' })).toHaveAttribute('aria-current', 'page');

    await act(async () => {
      answer({
        items: [createMarketplaceResourceItem({ title: 'Best-selling paid recipe', accessMode: 'paid', priceUsdCents: 900, post: null })],
        pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 },
      });
    });

    expect(await screen.findByText('Best-selling paid recipe')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading marketplace recipes')).not.toBeInTheDocument();
  });

  it('says a filtered listing could not load, and reads it again on Try again', async () => {
    answerListing(() => ({ status: 503, body: { error: 'Failed to load marketplace unlocks.' } }));
    address.search = '?access=free';

    await openPage();

    expect(await screen.findByRole('heading', { name: 'Recipes could not load' })).toBeInTheDocument();
    answerListing(() => ({
      body: {
        items: [createMarketplaceResourceItem({ title: 'Free recipe after retry', post: null })],
        pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 },
      },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Free recipe after retry')).toBeInTheDocument();
  });

  it('moves to another listing in place on a plain click, and leaves other clicks to the link', async () => {
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => undefined);
    await openPage();

    const free = screen.getByRole('link', { name: 'Free' });
    expect(free).toHaveAttribute('href', '/marketplace?access=free&sort=recent');
    fireEvent.click(free);
    expect(pushState).toHaveBeenCalledWith(null, '', '/marketplace?access=free&sort=recent');

    pushState.mockClear();
    fireEvent.click(free, { metaKey: true });
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
  });

  // A one- or two-character query was dropped without a word: every recipe
  // was listed and the search box emptied.
  it('answers a query under three characters with the hint, keeps it in the box, and lists nothing', async () => {
    address.search = '?q=ai&access=paid';

    await openPage();

    expect(await screen.findByRole('heading', { name: 'Type at least 3 characters' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search marketplace recipes/i })).toHaveValue('ai');
    // Clearing the search keeps the other filters.
    expect(screen.getByRole('link', { name: 'Clear search' })).toHaveAttribute('href', '/marketplace?access=paid&sort=recent');
    expect(listingReads()).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'No recipes yet' })).not.toBeInTheDocument();
  });

  it('builds a valid recent sort link and keeps both empty-state entry points visible', async () => {
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [],
    });

    await openPage();

    expect(await screen.findByRole('link', { name: /^recent$/i })).toHaveAttribute('href', '/marketplace?sort=recent');
    expect(screen.getAllByRole('link', { name: /share a post/i })[0]).toHaveAttribute(
      'href',
      '/post/new?from=marketplace&returnTo=%2Fmarketplace'
    );
    expect(screen.queryByRole('link', { name: /create a listing/i })).not.toBeInTheDocument();
  });

  it('renders text-only unlocks with note-style previews', async () => {
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [
        {
          id: 'bundle-1',
          postId: 'post-1',
          legacyAssetId: null,
          title: 'Prompt pacing unlock',
          summary: '',
          previewText: 'Prompt included.',
          accessMode: 'free',
          priceUsdCents: 0,
          salesCount: 0,
          freeUnlockCount: 0,
          earningsUsdCents: 0,
          allowRemix: false,
          resourceKinds: ['prompt'],
          lockedPreview: {
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
          },
          createdAt: '2026-04-25T10:00:00.000Z',
          updatedAt: '2026-04-25T10:00:00.000Z',
          seller: {
            id: 'creator-1',
            username: 'creator-name',
            name: 'Creator Name',
            avatar: null,
          },
          post: {
            id: 'post-1',
            title: 'Prompt pacing tip',
            category: 'text',
            body: 'Lead with the product benefit before adding style language.',
            postFormat: 'text',
            visibility: 'public',
            archivedAt: null,
            sourceKind: 'manual',
            sourceTool: null,
            sourceToolSlug: null,
            mediaUrl: null,
            mediaKind: null,
          },
          priceQuote: {
            currency: 'USD',
            amountSubunits: 0,
            formatted: '$0.00',
            note: null,
          },
        },
      ],
    });

    await openPage();

    // A text post is labelled "Text", as on the post page (it read "Tip / note").
    expect(await screen.findByText('Text')).toBeInTheDocument();
    expect(screen.getAllByText('Prompt pacing tip')).toHaveLength(2);
    expect(screen.getByText('Lead with the product benefit before adding style language.')).toBeInTheDocument();
    expect(screen.getByText('Free recipe')).toBeInTheDocument();
    expect(screen.queryByText('Text-only attached post')).not.toBeInTheDocument();
  });

  it('renders lazy images without attaching video bytes before interaction', async () => {
    getMarketplaceResourceListMock.mockResolvedValue({
      items: [
        createMarketplaceResourceItem({
          id: 'image-bundle',
          title: 'Image unlock',
          post: {
            id: 'image-post',
            title: 'Image post',
            category: 'image',
            body: '',
            postFormat: 'media',
            visibility: 'public',
            archivedAt: null,
            sourceKind: 'magicbooklet',
            sourceTool: null,
            sourceToolSlug: null,
            mediaUrl: 'https://example.com/image.jpg',
            mediaKind: 'image',
          },
        }),
        createMarketplaceResourceItem({
          id: 'video-bundle',
          title: 'Video unlock',
          postId: 'video-post',
          post: {
            id: 'video-post',
            title: 'Video post',
            category: 'video',
            body: '',
            postFormat: 'media',
            visibility: 'public',
            archivedAt: null,
            sourceKind: 'magicbooklet',
            sourceTool: null,
            sourceToolSlug: null,
            mediaUrl: 'https://example.com/video.mp4',
            mediaKind: 'video',
          },
        }),
      ],
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(await MarketplacePage()));
    });

    const image = await screen.findByRole('img', { name: 'Image post' });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).not.toHaveAttribute('src');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video).not.toHaveAttribute('autoplay');
  });
});

function createMarketplaceResourceItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bundle-1',
    postId: 'post-1',
    legacyAssetId: null,
    title: 'Prompt pacing unlock',
    summary: 'Prompt included.',
    previewText: 'Prompt included.',
    accessMode: 'free',
    priceUsdCents: 0,
    salesCount: 0,
    freeUnlockCount: 0,
    earningsUsdCents: 0,
    allowRemix: false,
    resourceKinds: ['prompt'],
    lockedPreview: {
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
    },
    createdAt: '2026-04-25T10:00:00.000Z',
    updatedAt: '2026-04-25T10:00:00.000Z',
    seller: {
      id: 'creator-1',
      username: 'creator-name',
      name: 'Creator Name',
      avatar: null,
    },
    post: {
      id: 'post-1',
      title: 'Prompt pacing tip',
      category: 'text',
      body: 'Lead with the product benefit before adding style language.',
      postFormat: 'text',
      visibility: 'public',
      archivedAt: null,
      sourceKind: 'manual',
      sourceTool: null,
      sourceToolSlug: null,
      mediaUrl: null,
      mediaKind: null,
    },
    priceQuote: {
      currency: 'USD',
      amountSubunits: 0,
      formatted: '$0.00',
      note: null,
    },
    ...overrides,
  };
}
