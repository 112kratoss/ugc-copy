import { render, screen } from '@testing-library/react';
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

function unlock(fields: { unlockId: string; title: string; accessMode: 'free' | 'paid'; purchasePriceUsdCents: number }) {
  return {
    bundleId: `bundle-${fields.unlockId}`,
    postId: `post-${fields.unlockId}`,
    previewText: '',
    priceUsdCents: fields.purchasePriceUsdCents,
    purchasedAt: '2026-10-01T00:00:00.000Z',
    hasNewerRevision: false,
    retired: false,
    tombstoned: false,
    post: { title: fields.title, mediaUrl: null },
    creator: { username: 'creator', displayName: 'Creator' },
    ...fields,
  };
}

it('prices each unlock in the credits it was bought with, grouped as the app groups them', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    items: [
      unlock({ unlockId: 'unlock-1', title: 'Launch kit', accessMode: 'paid', purchasePriceUsdCents: 1500 }),
      unlock({ unlockId: 'unlock-2', title: 'Starter prompt', accessMode: 'free', purchasePriceUsdCents: 0 }),
    ],
    pageInfo: { total: 2, hasMore: false, nextOffset: null },
  }))));

  render(<UnlockLibrary />);

  expect(await screen.findByText('1,500 credits')).toBeInTheDocument();
  expect(screen.getByText('Free')).toBeInTheDocument();
  // The app dropped the dollar figure beside it; so does the web now.
  expect(screen.queryByText(/\$15\.00/)).toBeNull();
});
