import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import UnlockLibrary from '@/app/creations/UnlockLibrary';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'token-1' } } })),
    },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

type UnlockPost = {
  title: string;
  mediaUrl: string | null;
  mediaKind: 'image' | 'video' | null;
  previewUrl: string | null;
};

function unlock(fields: Record<string, unknown> & { unlockId: string; title: string; post?: Partial<UnlockPost> | null }) {
  const { post, ...rest } = fields;
  return {
    bundleId: `bundle-${fields.unlockId}`,
    postId: `post-${fields.unlockId}`,
    previewText: '',
    accessMode: 'paid',
    priceUsdCents: 900,
    purchasedAt: '2026-10-01T00:00:00.000Z',
    purchasePriceUsdCents: 900,
    paidWith: 'credits',
    paidAmountSubunits: 900,
    paidCurrency: null,
    hasNewerRevision: false,
    retired: false,
    tombstoned: false,
    detached: false,
    isNsfw: false,
    creator: { username: 'creator', displayName: 'Creator' },
    ...rest,
    post: post === null
      ? null
      : { title: fields.title, mediaUrl: null, mediaKind: null, previewUrl: null, ...post },
  };
}

function renderLibrary(items: ReturnType<typeof unlock>[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    items,
    pageInfo: { total: items.length, hasMore: false, nextOffset: null },
  }))));
  render(<UnlockLibrary />);
}

async function findCard(title: string): Promise<HTMLElement> {
  const card = (await screen.findByText(title)).closest('li');
  if (!card) throw new Error(`no card for ${title}`);
  return card;
}

it('prices each unlock in the credits it was bought with, grouped as the app groups them', async () => {
  renderLibrary([
    unlock({ unlockId: 'unlock-1', title: 'Launch kit', paidWith: 'credits', paidAmountSubunits: 1500, purchasePriceUsdCents: 1500 }),
    unlock({
      unlockId: 'unlock-2',
      title: 'Starter prompt',
      accessMode: 'free',
      purchasePriceUsdCents: 0,
      paidWith: 'free',
      paidAmountSubunits: null,
    }),
  ]);

  expect(await screen.findByText('1,500 credits')).toBeInTheDocument();
  expect(screen.getByText('Free')).toBeInTheDocument();
  // The app dropped the dollar figure beside it; so does the web now.
  expect(screen.queryByText(/\$15\.00/)).toBeNull();
});

it('labels a Razorpay purchase in the currency it was paid in, never as credits', async () => {
  renderLibrary([
    unlock({ unlockId: 'unlock-inr', title: 'Rupee kit', paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' }),
    unlock({ unlockId: 'unlock-usd', title: 'Dollar kit', paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'USD' }),
    unlock({ unlockId: 'unlock-credits', title: 'Credit kit', paidWith: 'credits', paidAmountSubunits: 900 }),
    unlock({
      unlockId: 'unlock-free',
      title: 'Gift kit',
      accessMode: 'free',
      purchasePriceUsdCents: 0,
      paidWith: 'free',
      paidAmountSubunits: null,
    }),
  ]);

  const rupees = await findCard('Rupee kit');
  expect(within(rupees).getByText('₹750 paid')).toBeInTheDocument();
  // Its USD-cent price of 900 used to print as "900 credits".
  expect(within(rupees).queryByText(/credits/)).toBeNull();
  expect(within(await findCard('Dollar kit')).getByText('$9.00 paid')).toBeInTheDocument();
  expect(within(await findCard('Credit kit')).getByText('900 credits')).toBeInTheDocument();
  expect(within(await findCard('Gift kit')).getByText('Free')).toBeInTheDocument();
});

it("draws each tile from a still: a video's poster, an image's own file, else the package mark", async () => {
  renderLibrary([
    unlock({
      unlockId: 'unlock-video',
      title: 'Video with a poster',
      post: { mediaKind: 'video', mediaUrl: '/api/media?path=clip.mp4', previewUrl: '/api/media?path=clip-poster.webp' },
    }),
    unlock({
      unlockId: 'unlock-video-bare',
      title: 'Video without a poster',
      post: { mediaKind: 'video', mediaUrl: '/api/media?path=bare.mp4', previewUrl: null },
    }),
    unlock({
      unlockId: 'unlock-image',
      title: 'Image without a preview',
      post: { mediaKind: 'image', mediaUrl: 'https://cdn.example/still.png', previewUrl: null },
    }),
  ]);

  const poster = await findCard('Video with a poster');
  expect(poster.querySelector('img')).toHaveAttribute('src', '/api/media?path=clip-poster.webp');

  const bare = await findCard('Video without a poster');
  // An <img> cannot draw an MP4, so a video with no poster gets the mark.
  expect(bare.querySelector('img')).toBeNull();
  expect(bare.querySelector('svg.lucide-package-open')).not.toBeNull();

  const image = await findCard('Image without a preview');
  expect(image.querySelector('img')).toHaveAttribute('src', 'https://cdn.example/still.png');
});

it('covers a mature unlock with a plate whose Show reveals the still in place, without opening the unlock', async () => {
  renderLibrary([
    unlock({
      unlockId: 'unlock-nsfw',
      title: 'After dark',
      isNsfw: true,
      post: { mediaKind: 'image', mediaUrl: '/api/media?path=full.png', previewUrl: '/api/media?path=preview.webp' },
    }),
  ]);

  const card = await findCard('After dark');
  expect(within(card).getByText('Mature content')).toBeInTheDocument();
  expect(card.querySelector('img')).toBeNull();

  // The plate sits inside the card's link; its click must not follow it.
  expect(fireEvent.click(within(card).getByRole('button', { name: 'Show mature content' }))).toBe(false);

  expect(card.querySelector('img')).toHaveAttribute('src', '/api/media?path=preview.webp');
  expect(within(card).queryByText('Mature content')).toBeNull();
  expect(within(card).getByRole('link')).toHaveAttribute('href', '/unlocks/unlock-nsfw');
});

it('draws no plate over a mature unlock that has no still to cover', async () => {
  renderLibrary([
    unlock({
      unlockId: 'unlock-nsfw-video',
      title: 'Late clip',
      isNsfw: true,
      post: { mediaKind: 'video', mediaUrl: '/api/media?path=late.mp4', previewUrl: null },
    }),
  ]);

  const card = await findCard('Late clip');
  expect(within(card).queryByText('Mature content')).toBeNull();
  expect(card.querySelector('svg.lucide-package-open')).not.toBeNull();
});

it('says "Creator left" on an unlock whose creator deleted their account', async () => {
  renderLibrary([
    unlock({ unlockId: 'unlock-detached', title: 'Orphaned kit', bundleId: null, postId: null, detached: true, post: null }),
    unlock({ unlockId: 'unlock-live', title: 'Live kit' }),
  ]);

  expect(within(await findCard('Orphaned kit')).getByText('Creator left')).toBeInTheDocument();
  expect(within(await findCard('Live kit')).queryByText('Creator left')).toBeNull();
});

// The buyer's library is "Unlocked recipes" (B-F9, B-F10): it counted
// "unlocks" and its empty state sent buyers to "Browse unlocks".
it('counts recipes, in recipe words', async () => {
  renderLibrary([unlock({ unlockId: 'u1', title: 'One' }), unlock({ unlockId: 'u2', title: 'Two' })]);

  expect(await screen.findByText('2 recipes · yours permanently')).toBeInTheDocument();
  expect(screen.queryByText(/unlocks/i)).toBeNull();
});

it('says so when there are none yet, and where to find some', async () => {
  renderLibrary([]);

  expect(await screen.findByText('No unlocked recipes yet')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /browse recipes/i })).toHaveAttribute('href', '/marketplace');
  expect(screen.queryByText(/no unlocks yet|browse unlocks/i)).toBeNull();
});
