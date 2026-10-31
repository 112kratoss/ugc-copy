import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The payout panel on this page reads the browser Supabase singleton, which
// needs real env vars to construct. The dashboard assertions below are about
// recipe rendering, so stub the client rather than the whole panel.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

vi.stubGlobal('fetch', vi.fn(async () => new Response(
  JSON.stringify({
    availableUsd: '$0.00',
    minimumUsd: '$100.00',
    canRequest: false,
    pendingRequest: null,
    history: [],
  }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)));

import MarketplaceSellClient from '@/app/marketplace/sell/MarketplaceSellClient';

type Kinds = Array<'prompt' | 'workflow' | 'files' | 'notes' | 'remix'>;

const paidRecipe = {
  id: 'bundle-1',
  postId: 'post-public',
  title: 'Launch resources',
  summary: 'Reusable launch notes.',
  previewText: 'See the exact structure.',
  accessMode: 'paid' as const,
  status: 'published' as const,
  priceUsdCents: 1900,
  salesCount: 4,
  freeUnlockCount: 0,
  earningsUsdCents: 7600,
  priceQuote: {
    currency: 'INR' as const,
    amountSubunits: 159900,
    formatted: '₹1,599',
    note: 'Charged in INR for buyers in India.',
  },
  resourceKinds: ['prompt', 'notes'] as Kinds,
  createdAt: '2026-04-06T00:00:00.000Z',
  updatedAt: '2026-04-07T00:00:00.000Z',
  quality: {
    eligible: true,
    issues: [],
  },
  post: {
    id: 'post-public',
    title: 'Launch proof',
    visibility: 'public',
    archivedAt: null,
    saveCount: 3,
    remixCount: 1,
    shareVisitCount: 20,
  },
};

const freeRecipe = {
  ...paidRecipe,
  id: 'bundle-free',
  postId: 'post-free',
  title: 'Free starter notes',
  accessMode: 'free' as const,
  priceUsdCents: 0,
  priceQuote: undefined,
  salesCount: 0,
  freeUnlockCount: 3,
  earningsUsdCents: 0,
  resourceKinds: ['prompt'] as Kinds,
  createdAt: '2026-05-01T00:00:00.000Z',
  post: { ...paidRecipe.post, id: 'post-free', title: 'Free proof', saveCount: 9, shareVisitCount: 2 },
};

const dashboard = {
  bundles: [paidRecipe],
  deletedSnapshots: [],
  recentUnlocks: [],
  recipeCandidates: [],
  totalSalesCount: 4,
  totalFreeUnlockCount: 0,
  totalEarningsUsdCents: 7600,
};

const emptyDashboard = {
  bundles: [],
  deletedSnapshots: [],
  recentUnlocks: [],
  recipeCandidates: [],
  totalSalesCount: 0,
  totalFreeUnlockCount: 0,
  totalEarningsUsdCents: 0,
};

const candidate = {
  postId: 'post-saved',
  title: 'Camcorder battle',
  postFormat: 'media',
  mediaKind: 'video',
  mediaUrl: null,
  mediaPreviewUrl: null,
  saveCount: 2,
  remixCount: 0,
  shareVisitCount: 8,
};

function rowOf(name: string) {
  return screen.getByRole('link', { name }).closest('li') as HTMLElement;
}

describe('MarketplaceSellClient', () => {
  it('lists each recipe under its post, with its price, counts and where it opens', () => {
    render(<MarketplaceSellClient initialDashboard={dashboard} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Recipe sales' })).toBeInTheDocument();
    const row = rowOf('Launch proof');
    // A live recipe opens where buyers see it, with the way back here.
    expect(within(row).getByRole('link', { name: 'Launch proof' })).toHaveAttribute(
      'href',
      '/showcase/post-public?from=seller&returnTo=%2Fmarketplace%2Fsell#recipe',
    );
    expect(within(row).getByText('1,900 credits', { selector: 'span.hidden span' })).toBeInTheDocument();
    // What buyers paid, not the seller's share, which the Earnings tile shows (review 10).
    expect(within(row).getByText('Prompt, Notes · 4 sold · $76.00 in sales')).toBeInTheDocument();
    // Each count names itself: the header over them is for the eye (review 15).
    expect(row).toHaveTextContent('4 unlocks');
    expect(row).toHaveTextContent('3 saves');
    expect(row).toHaveTextContent('20 link visits');
    expect(within(row).getByRole('button', { name: 'Copy recipe link' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Edit recipe' })).toHaveAttribute(
      'href',
      '/post/post-public/edit?from=seller&returnTo=%2Fmarketplace%2Fsell#recipe',
    );
    // A live recipe carries no status of its own.
    expect(within(row).queryByText(/Ready|Live/)).not.toBeInTheDocument();
  });

  // The listing's chip printed "$0.50 recipe" for a recipe only credits buy;
  // every chip prices a recipe in credits.
  it('prices a recipe in credits', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{
            ...paidRecipe,
            priceUsdCents: 50,
            priceQuote: { currency: 'USD', amountSubunits: 50, formatted: '$0.50', note: null },
          }],
        }}
      />
    );

    expect(within(rowOf('Launch proof')).getAllByText('50 credits')).not.toHaveLength(0);
    expect(screen.queryByText(/\$0\.50/)).not.toBeInTheDocument();
  });

  it('offers a seller with no recipes their posts to add one to, and the composer', () => {
    render(<MarketplaceSellClient initialDashboard={{ ...emptyDashboard, recipeCandidates: [candidate] }} />);

    expect(screen.getByRole('heading', { name: 'Add your first recipe' })).toBeInTheDocument();
    // The editor names the add intent, as Studio's Add recipe opens it (review 12).
    expect(screen.getByRole('link', { name: 'Add a recipe to Camcorder battle' })).toHaveAttribute(
      'href',
      '/post/post-saved/edit?recipe=add&from=seller&returnTo=%2Fmarketplace%2Fsell#recipe',
    );
    expect(screen.getByRole('link', { name: 'Share a new post' })).toHaveAttribute(
      'href',
      '/post/new?from=seller&returnTo=%2Fmarketplace%2Fsell',
    );
    // A page of zeros says nothing to someone who has sold nothing yet.
    expect(screen.queryByRole('region', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a recipe' })).not.toBeInTheDocument();
  });

  // Review 13: no posts to offer read "Every public post of yours has a
  // recipe." also to a seller with no posts, and when they could not be read.
  it.each([
    ['a seller with no posts', emptyDashboard, [], 'Your public posts show up here once you share one.'],
    ['a seller whose posts could not be read', emptyDashboard, null, 'Your posts could not be loaded. Reload the page to try again.'],
  ] as const)('says what no posts to add a recipe to means for %s', (_name, base, recipeCandidates, text) => {
    render(<MarketplaceSellClient initialDashboard={{ ...base, recipeCandidates: recipeCandidates === null ? null : [...recipeCandidates] }} />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('Every public post of yours has a recipe.')).not.toBeInTheDocument();
  });

  it('opens and closes the picker of posts without a recipe from Add a recipe', () => {
    render(<MarketplaceSellClient initialDashboard={{ ...dashboard, recipeCandidates: [candidate] }} />);

    const add = screen.getByRole('button', { name: 'Add a recipe' });
    expect(add).toHaveAttribute('aria-expanded', 'false');
    expect(add).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('group', { name: 'Add a recipe to a post' })).not.toBeInTheDocument();

    fireEvent.click(add);

    const picker = screen.getByRole('group', { name: 'Add a recipe to a post' });
    expect(add).toHaveAttribute('aria-expanded', 'true');
    expect(add).toHaveAttribute('aria-controls', picker.id);
    expect(within(picker).getByRole('link', { name: 'Add a recipe to Camcorder battle' })).toBeInTheDocument();
    // The suggestions beside the list offer the same post.
    expect(screen.getByRole('heading', { name: 'Ready for a recipe' })).toBeInTheDocument();

    fireEvent.click(add);
    expect(screen.queryByRole('group', { name: 'Add a recipe to a post' })).not.toBeInTheDocument();
  });

  it('says so when every public post already has a recipe', () => {
    render(<MarketplaceSellClient initialDashboard={dashboard} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add a recipe' }));

    // Not "Every public post of yours has a recipe.": the seller may have no
    // public post at all (second review).
    expect(screen.getByText('No public post of yours is waiting for a recipe.')).toBeInTheDocument();
  });

  // Review 4: the Earnings tile showed only beside recipes, but a balance can
  // outlive them (a legacy listing, every recipe gone).
  it('keeps the Earnings tile for a seller with a balance and no recipes', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(
      JSON.stringify({
        availableUsd: '$120.00',
        minimumUsd: '$100.00',
        canRequest: true,
        pendingRequest: null,
        history: [],
        availableTokenSubunits: 1_200_000,
        minimumTokenSubunits: 1_000_000,
        lifetimeEarnedTokenSubunits: 1_200_000,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    render(<MarketplaceSellClient initialDashboard={emptyDashboard} />);

    expect(await screen.findByRole('button', { name: 'Withdraw $120.00' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add your first recipe' })).toBeInTheDocument();
  });

  // Review 11: the post page counts a visit only from a link that names where
  // it was shared from, and Link visits is that count.
  it('copies a recipe link that counts the visits it brings', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MarketplaceSellClient initialDashboard={dashboard} />);

    fireEvent.click(within(rowOf('Launch proof')).getByRole('button', { name: 'Copy recipe link' }));

    expect(await screen.findByText('Recipe link copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/showcase/post-public?s=my-creations#recipe`);
  });

  // Review 15: "Show all" removed itself and left the keyboard on the page body.
  it('moves the focus to the first row Show all draws', () => {
    const recipes = Array.from({ length: 9 }, (_, index) => ({
      ...paidRecipe,
      id: `bundle-${index + 1}`,
      postId: `post-${index + 1}`,
      // Newest first: the ninth is the oldest.
      createdAt: new Date(Date.UTC(2026, 3, 20 - index)).toISOString(),
      salesCount: 0,
      earningsUsdCents: 0,
      post: { ...paidRecipe.post, id: `post-${index + 1}`, title: `Recipe ${index + 1}` },
    }));
    render(<MarketplaceSellClient initialDashboard={{ ...dashboard, bundles: recipes }} />);

    expect(screen.queryByRole('link', { name: 'Recipe 9' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show all 9/ }));

    expect(screen.getByRole('link', { name: 'Recipe 9' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  // The edit links carried no way back, so the editor's back link went to the
  // studio instead of this page. A paid recipe nobody can buy says so.
  it('opens a recipe that is not live in the editor, and says a paid one is not on sale', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{ ...paidRecipe, post: { ...paidRecipe.post, visibility: 'private' } }],
        }}
      />
    );

    const row = rowOf('Launch proof');
    expect(within(row).getByRole('link', { name: 'Launch proof' })).toHaveAttribute(
      'href',
      '/post/post-public/edit?from=seller&returnTo=%2Fmarketplace%2Fsell#recipe',
    );
    expect(within(row).getByText(/Private post/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Copy recipe link' })).not.toBeInTheDocument();
    expect(screen.getByText('1 paid recipe isn’t on sale.')).toBeInTheDocument();
    expect(screen.getByText(/Nobody can buy it until it’s live\./)).toBeInTheDocument();
  });

  it('calls paid drafts drafts, and shows only the recipes that are not live when asked', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{ ...paidRecipe, status: 'draft' as const }, freeRecipe],
        }}
      />
    );

    expect(screen.getByText('1 paid recipe isn’t on sale.')).toBeInTheDocument();
    expect(screen.getByText(/It’s still a draft, so nobody can buy it\./)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Show what isn’t live' }));

    // The button goes with the filter it set; the focus goes to that filter (review 15).
    expect(screen.getByRole('button', { name: /Not live/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Not live/ })).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Launch proof' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Free proof' })).not.toBeInTheDocument();
  });

  it('orders recipes by unlocks, or by what the seller picks', () => {
    render(<MarketplaceSellClient initialDashboard={{ ...dashboard, bundles: [paidRecipe, freeRecipe] }} />);

    const titles = () => screen.getAllByRole('listitem').map((item) => within(item).getAllByRole('link')[0].textContent);
    // Unlocks: 4 sold against 3 opened.
    expect(titles()).toEqual(['Launch proof', 'Free proof']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort recipes' }), { target: { value: 'saves' } });
    expect(titles()).toEqual(['Free proof', 'Launch proof']);
  });

  // A free unlock stopped counting as a sale on 2026-10-17 (decision 6): the
  // totals count both, apart.
  it('totals unlocks with the free and the sold apart, and adds up saves and link visits', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{ ...paidRecipe, freeUnlockCount: 2 }, freeRecipe],
          totalSalesCount: 4,
          totalFreeUnlockCount: 5,
        }}
      />
    );

    const overview = screen.getByRole('region', { name: 'Overview' });
    expect(within(overview).getByText('9')).toBeInTheDocument();
    expect(within(overview).getByText('5 opened free · 4 sold')).toBeInTheDocument();
    expect(within(overview).getByText('12')).toBeInTheDocument();
    // Counted over the posts with a recipe, which the tile says (second review).
    expect(within(overview).getByText('and 2 remixes, on posts with a recipe')).toBeInTheDocument();
    expect(within(overview).getByText('Visits from shared links')).toBeInTheDocument();
    expect(within(overview).getByText('22')).toBeInTheDocument();
    // The free recipe's line names what it holds; its opens are the Unlocks column's.
    expect(within(rowOf('Free proof')).getByText('Prompt')).toBeInTheDocument();
  });

  // A post deleted after a sale is private and archived for its buyers. It read
  // "Needs work · Archived post", asked the seller to publish it again, and
  // offered the editor.
  it('labels a post deleted after a sale and offers no edit', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{
            ...paidRecipe,
            quality: {
              eligible: false,
              issues: [{
                code: 'post_not_public',
                field: 'post',
                message: 'Publish a visible public post before listing this recipe in the marketplace.',
              }],
            },
            post: {
              ...paidRecipe.post,
              visibility: 'private',
              archivedAt: '2026-10-10T00:00:00.000Z',
              tombstoned: true,
            },
          }],
        }}
      />
    );

    const row = screen.getByText('Launch proof').closest('li') as HTMLElement;
    expect(within(row).getByText(/Deleted · buyers keep access/)).toBeInTheDocument();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/Archived post|Needs work/)).not.toBeInTheDocument();
    expect(screen.queryByText(/publish a visible public post/i)).not.toBeInTheDocument();
    // Not on sale, but nothing the seller can fix: no callout.
    expect(screen.queryByText(/isn’t on sale/)).not.toBeInTheDocument();
  });

  // Review 6: a recipe removed after it sold is a draft with retired_at set,
  // and read as a draft the seller was asked to publish. Second review: its
  // row opened nothing, though the editor adds a recipe to its post again.
  it('labels a recipe removed after it was unlocked, and opens its post to add one again', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{ ...paidRecipe, status: 'draft' as const, retiredAt: '2026-10-20T00:00:00.000Z' }],
        }}
      />
    );

    const row = rowOf('Launch proof');
    expect(within(row).getByText(/Removed · buyers keep access/)).toBeInTheDocument();
    const addAgain = '/post/post-public/edit?recipe=add&from=seller&returnTo=%2Fmarketplace%2Fsell#recipe';
    expect(within(row).getByRole('link', { name: 'Launch proof' })).toHaveAttribute('href', addAgain);
    expect(within(row).getByRole('link', { name: 'Add a recipe again' })).toHaveAttribute('href', addAgain);
    expect(within(row).queryByRole('button', { name: 'Copy recipe link' })).not.toBeInTheDocument();
    expect(screen.queryByText(/isn’t on sale|still a draft/)).not.toBeInTheDocument();
  });

  // Review 5: checkout asks only for a published recipe on a public, visible
  // post, so one the listing check turns down still sells from its post.
  it('says what keeps a recipe on sale out of the marketplace, and keeps its link', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [{
            ...paidRecipe,
            quality: { eligible: false, issues: [{ code: 'missing_preview', field: 'previewText', message: 'Add a recipe preview.' }] },
          }],
        }}
      />
    );

    const row = rowOf('Launch proof');
    expect(within(row).getByText(/Not in the marketplace/)).toBeInTheDocument();
    expect(within(row).getByText('Add a recipe preview.')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Launch proof' })).toHaveAttribute(
      'href',
      '/showcase/post-public?from=seller&returnTo=%2Fmarketplace%2Fsell#recipe',
    );
    expect(within(row).getByRole('button', { name: 'Copy recipe link' })).toBeInTheDocument();
    // The chip's name keeps a space between its label and count (second review).
    expect(screen.getByRole('button', { name: 'Live 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/isn’t on sale/)).not.toBeInTheDocument();
  });

  it('lists who opened or bought which recipe, newest first', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          bundles: [paidRecipe, freeRecipe],
          generatedAt: '2026-10-31T00:00:00.000Z',
          recentUnlocks: [
            { id: 'order-2', bundleId: 'bundle-1', buyerLabel: '@maya', named: true, paid: true, paidInCredits: false, amountSubunits: 1900, currency: 'USD' as const, createdAt: '2026-10-30T10:00:00.000Z' },
            { id: 'order-1', bundleId: 'bundle-free', buyerLabel: 'Someone', named: false, paid: false, paidInCredits: false, amountSubunits: 0, currency: 'USD' as const, createdAt: '2026-10-29T10:00:00.000Z' },
          ],
        }}
      />
    );

    const unlocks = screen.getByRole('heading', { name: 'Recent unlocks' }).closest('section') as HTMLElement;
    const items = within(unlocks).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('@maya bought Launch proof');
    expect(items[0]).toHaveTextContent('$19.00');
    expect(items[0]).toHaveTextContent(/^M/);
    expect(items[1]).toHaveTextContent('Someone opened Free proof');
    expect(items[1]).toHaveTextContent('Free');
    // Someone unnamed has no initial: "S" would read as theirs.
    expect(items[1].querySelector('[aria-hidden="true"] svg')).not.toBeNull();
  });

  // Review 9: charAt(0) took half of an emoji's surrogate pair, which reaches
  // the browser as U+FFFD from the server and as itself from the client.
  it('draws a whole character for a buyer whose name starts with an emoji', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          recentUnlocks: [
            { id: 'order-1', bundleId: 'bundle-1', buyerLabel: '🎨 Maya', named: true, paid: true, paidInCredits: false, amountSubunits: 1900, currency: 'USD' as const, createdAt: '2026-10-30T10:00:00.000Z' },
          ],
        }}
      />
    );

    const unlocks = screen.getByRole('heading', { name: 'Recent unlocks' }).closest('section') as HTMLElement;
    const initials = within(unlocks).getByRole('listitem').querySelector('[aria-hidden="true"]')?.textContent ?? '';
    expect(initials.startsWith('🎨')).toBe(true);
    // A lone surrogate does not survive UTF-8, the way the page reaches the browser.
    expect(new TextDecoder().decode(new TextEncoder().encode(initials))).toBe(initials);
  });

  // Second review: a sale paid with credits read as a dollar amount, and a
  // deleted post's recipe as a cash price, beside rows priced in credits.
  it('prices credit sales and deleted posts’ recipes in credits', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          recentUnlocks: [
            { id: 'order-1', bundleId: 'bundle-1', buyerLabel: '@maya', named: true, paid: true, paidInCredits: true, amountSubunits: 50, currency: 'USD' as const, createdAt: '2026-10-30T10:00:00.000Z' },
          ],
          deletedSnapshots: [{
            id: 'audit-1',
            title: 'Old drop',
            visibility: 'public',
            bundleAccessMode: 'paid' as const,
            bundleStatus: 'published' as const,
            bundlePriceUsdCents: 900,
            resourceKinds: ['prompt'] as Kinds,
            salesCount: 2,
            earningsUsdCents: 1530,
            hadPaidOrders: true,
            deletedAt: '2026-10-01T00:00:00.000Z',
          }],
        }}
      />
    );

    const unlocks = screen.getByRole('heading', { name: 'Recent unlocks' }).closest('section') as HTMLElement;
    expect(within(unlocks).getByRole('listitem')).toHaveTextContent('50 credits');
    expect(within(unlocks).queryByText(/\$0\.50/)).not.toBeInTheDocument();
    expect(screen.getByText('Old drop').closest('li')).toHaveTextContent('900 credits');
    expect(screen.queryByText(/\$9\.00/)).not.toBeInTheDocument();
  });

  // Second review: a date under 300 days old dropped its year, so last
  // April read as this April in February.
  it('names the year of a date from another year than the page’s read', () => {
    render(
      <MarketplaceSellClient
        initialDashboard={{
          ...dashboard,
          generatedAt: '2027-02-01T00:00:00.000Z',
          recentUnlocks: [
            { id: 'order-1', bundleId: 'bundle-1', buyerLabel: '@maya', named: true, paid: true, paidInCredits: false, amountSubunits: 1900, currency: 'USD' as const, createdAt: '2026-04-20T10:00:00.000Z' },
          ],
        }}
      />
    );

    const unlocks = screen.getByRole('heading', { name: 'Recent unlocks' }).closest('section') as HTMLElement;
    expect(within(unlocks).getByRole('listitem').querySelector('time')?.textContent).toMatch(/2026/);
  });

  // The server renders in UTC and the seller's browser hydrates in its own
  // zone: `toLocaleString()` printed another day there, and React threw the
  // server's markup away.
  it("hydrates the unlock and deletion dates without a mismatch, then shows them in the seller's zone", async () => {
    const unlockedAt = '2026-10-14T20:00:00.000Z';
    const history = {
      ...dashboard,
      generatedAt: '2026-10-15T00:00:00.000Z',
      recentUnlocks: [{
        id: 'order-1',
        bundleId: 'bundle-1',
        buyerLabel: '@buyer',
        named: true,
        paid: true,
        paidInCredits: false,
        amountSubunits: 41550,
        currency: 'INR' as const,
        createdAt: unlockedAt,
      }],
      deletedSnapshots: [{
        id: 'audit-1',
        title: 'Old drop',
        visibility: 'public',
        bundleAccessMode: 'paid' as const,
        bundleStatus: 'published' as const,
        bundlePriceUsdCents: 900,
        resourceKinds: ['prompt'] as Kinds,
        salesCount: 2,
        earningsUsdCents: 1530,
        hadPaidOrders: true,
        deletedAt: unlockedAt,
      }],
    };
    const serverTimeZone = process.env.TZ;
    const container = document.createElement('div');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot> | null = null;

    try {
      process.env.TZ = 'UTC';
      container.innerHTML = renderToString(<MarketplaceSellClient initialDashboard={history} />);
      document.body.appendChild(container);
      const serverTimes = Array.from(container.querySelectorAll('time')).map((time) => time.textContent);
      expect(serverTimes).toEqual(['Oct 14', 'Oct 14', 'Oct 14']);
      expect(container).toHaveTextContent('₹415.50');

      process.env.TZ = 'Asia/Kolkata';
      const sellerDay = new Date(unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const recoverableErrors: unknown[] = [];
      await act(async () => {
        root = hydrateRoot(
          container,
          <MarketplaceSellClient initialDashboard={history} />,
          { onRecoverableError: (error) => recoverableErrors.push(error) },
        );
      });

      expect(recoverableErrors).toEqual([]);
      const times = Array.from(container.querySelectorAll('time'));
      expect(times.map((time) => [time.getAttribute('datetime'), time.textContent])).toEqual([
        [unlockedAt, sellerDay],
        [unlockedAt, sellerDay],
        [unlockedAt, sellerDay],
      ]);
      expect(sellerDay).toContain('15');
      expect(container).toHaveTextContent('₹415.50');
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
      consoleError.mockRestore();
      if (serverTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = serverTimeZone;
      }
    }
  });
});
