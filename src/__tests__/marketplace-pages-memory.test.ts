import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMarketplacePagesKey,
  fitsMarketplacePagesMemory,
  MARKETPLACE_PAGES_MEMORY_MAX_ITEMS,
  MARKETPLACE_PAGES_MEMORY_MAX_LISTINGS,
  MARKETPLACE_PAGES_MEMORY_TTL_MS,
  marketplacePagesViewer,
  recallMarketplaceFiltersOpen,
  recallMarketplacePages,
  rememberMarketplaceFiltersOpen,
  rememberMarketplacePages,
  takeBlockedCreatorOffMarketplacePages,
  withRememberedPages,
  type MarketplacePages,
} from '@/lib/marketplace-pages-memory';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

// The block a viewer makes from any page, through the shared client every surface calls.
vi.mock('@/components/feedback-state', () => ({
  pushToast: vi.fn(),
  requestConfirmation: vi.fn(async () => true),
}));
vi.mock('@/lib/moderation-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/moderation-client')>()),
  blockCreator: vi.fn(async () => undefined),
}));
vi.mock('@/lib/product-analytics', () => ({ trackProductEvent: vi.fn() }));

// What "Load more" brought to a Marketplace listing, kept for the tab so Back from a recipe draws it
// again (the listing's half is marketplace-browser-progressive-render's, the shell's hand-over
// marketplace-bootstrap's).

const item = (id: string, sellerId = `seller-of-${id}`) => ({ id, seller: { id: sellerId } }) as MarketplaceResourceListItem;

function pages(ids: string[], hasMore: boolean): MarketplacePages {
  return {
    items: ids.map((id) => item(id)),
    pageInfo: { hasMore, nextOffset: hasMore ? ids.length : null, offset: 0, limit: ids.length },
  };
}

const ids = (listing: MarketplacePages | null) => listing?.items.map((entry) => entry.id) ?? null;
const KEY = buildMarketplacePagesKey('all/all//recent/', null);

afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe('a Marketplace listing kept for the tab', () => {
  it('gives the listing back as it was left', () => {
    rememberMarketplacePages(KEY, 2, pages(['a', 'b', 'c', 'd'], false));

    expect(ids(recallMarketplacePages(KEY))).toEqual(['a', 'b', 'c', 'd']);
    expect(recallMarketplacePages(KEY)?.pageInfo.hasMore).toBe(false);
  });

  it('keeps nothing for a listing at its first page', () => {
    rememberMarketplacePages(KEY, 2, pages(['a', 'b', 'c'], true));
    rememberMarketplacePages(KEY, 2, pages(['a', 'b'], true));

    expect(recallMarketplacePages(KEY)).toBeNull();
  });

  it('keeps each listing and each viewer apart', () => {
    rememberMarketplacePages(KEY, 2, pages(['a', 'b', 'c'], false));

    expect(recallMarketplacePages(buildMarketplacePagesKey('free/all//recent/', null))).toBeNull();
    expect(recallMarketplacePages(buildMarketplacePagesKey('all/all//recent/', 'viewer-1'))).toBeNull();
  });

  // Owner's recording, 2026-11-16: signed in, Back drew the first page alone, as the page's auth
  // provider was still asking who was signed in and the listing was looked for as a visitor's.
  describe('for the viewer the page can name', () => {
    const SESSION_COOKIE = 'sb-project-auth-token';
    const session = (userId: string) => `base64-${btoa(JSON.stringify({ access_token: 'token', user: { id: userId } }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

    afterEach(() => {
      document.cookie = `${SESSION_COOKIE}=; Max-Age=0; Path=/`;
      vi.unstubAllEnvs();
    });

    it('is the signed-in viewer, once the page knows them', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
      document.cookie = `${SESSION_COOKIE}=${session('cookie-viewer')}; Path=/`;

      expect(marketplacePagesViewer({ userId: 'viewer-1', isLoading: false })).toBe('viewer-1');
      expect(marketplacePagesViewer({ userId: 'viewer-1', isLoading: true })).toBe('viewer-1');
    });

    it('is the account the session cookie names while the page is still asking', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
      document.cookie = `${SESSION_COOKIE}=${session('viewer-1')}; Path=/`;
      rememberMarketplacePages(buildMarketplacePagesKey('all/all//recent/', 'viewer-1'), 2, pages(['a', 'b', 'c'], false));

      const viewer = marketplacePagesViewer({ userId: null, isLoading: true });
      expect(viewer).toBe('viewer-1');
      expect(ids(recallMarketplacePages(buildMarketplacePagesKey('all/all//recent/', viewer)))).toEqual(['a', 'b', 'c']);
    });

    it('is a visitor once the page has found nobody signed in, whatever the cookie says, or with no cookie', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
      expect(marketplacePagesViewer({ userId: null, isLoading: true })).toBeNull();

      document.cookie = `${SESSION_COOKIE}=${session('viewer-1')}; Path=/`;
      expect(marketplacePagesViewer({ userId: null, isLoading: false })).toBeNull();
    });
  });

  it('passes over a listing kept longer than ten minutes ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(performance.timeOrigin + 60_000);
    rememberMarketplacePages(KEY, 2, pages(['a', 'b', 'c'], false));

    vi.setSystemTime(Date.now() + MARKETPLACE_PAGES_MEMORY_TTL_MS + 1);
    expect(recallMarketplacePages(KEY)).toBeNull();
  });

  // A reload starts the listing at its first page, as Explore's grid does; and the page the
  // server drew hydrates on its first page alone.
  it('never gives back a listing kept before this document loaded', () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({
      ...pages(['a', 'b', 'c'], false),
      savedAt: performance.timeOrigin - 1,
    }));

    expect(recallMarketplacePages(KEY)).toBeNull();
  });
});

describe('the fresh first page in front of what was kept', () => {
  it('carries on where the listing was left, with the fresh copies of the first page', () => {
    const fresh = { ...pages(['a', 'b'], true), items: [{ ...item('a'), title: 'fresh' } as MarketplaceResourceListItem, item('b')] };

    const drawn = withRememberedPages(fresh, pages(['a', 'b', 'c', 'd'], false));

    expect(ids(drawn)).toEqual(['a', 'b', 'c', 'd']);
    expect(drawn.items[0]).toBe(fresh.items[0]);
    expect(drawn.pageInfo.hasMore).toBe(false);
  });

  it('keeps every recipe in its order when the listing has moved at its top', () => {
    // A recipe published since: the fresh first page starts with it, and the one it pushed off the
    // first page comes next, ahead of the kept later pages.
    expect(ids(withRememberedPages(pages(['new', 'a'], true), pages(['a', 'b', 'c', 'd'], false))))
      .toEqual(['new', 'a', 'b', 'c', 'd']);
  });

  it('is the first page alone when nothing was kept, or nothing beyond it', () => {
    const first = pages(['a', 'b'], true);

    expect(withRememberedPages(first, null)).toBe(first);
    expect(withRememberedPages(first, pages(['b', 'a'], true))).toBe(first);
  });

  it('is what was kept while the listing has no first page yet', () => {
    const empty = { items: [], pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 4 } };

    expect(ids(withRememberedPages(empty, pages(['a', 'b', 'c'], true)))).toEqual(['a', 'b', 'c']);
  });
});

// Review of #815: what is kept must not outlive a block, nor crowd the feeds' snapshots out of
// session storage.
describe('what the tab keeps', () => {
  it('takes a creator blocked meanwhile out of every listing kept', () => {
    const other = buildMarketplacePagesKey('paid/all//recent/', 'viewer-1');
    rememberMarketplacePages(KEY, 1, { ...pages([], false), items: [item('a'), item('b', 'blocked'), item('c')] });
    rememberMarketplacePages(other, 1, { ...pages([], false), items: [item('d', 'blocked'), item('e')] });

    takeBlockedCreatorOffMarketplacePages('blocked');

    expect(ids(recallMarketplacePages(KEY))).toEqual(['a', 'c']);
    expect(ids(recallMarketplacePages(other))).toEqual(['e']);
  });

  it('loses a creator at the block itself, wherever it is made', async () => {
    rememberMarketplacePages(KEY, 1, { ...pages([], false), items: [item('a'), item('b', 'creator-1'), item('c')] });

    const actions = await import('@/lib/feed-safety-actions');
    await actions.blockCreatorAfterConfirmation({ userId: 'creator-1', creatorName: 'Luna', accessToken: 'token' });

    expect(ids(recallMarketplacePages(KEY))).toEqual(['a', 'c']);
  });

  it('keeps a few listings, letting the one kept longest ago go first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(performance.timeOrigin + 60_000);
    const keys = Array.from({ length: MARKETPLACE_PAGES_MEMORY_MAX_LISTINGS + 1 }, (_, index) => (
      buildMarketplacePagesKey(`all/all//recent/${index}`, null)
    ));
    for (const key of keys) {
      rememberMarketplacePages(key, 1, pages(['a', 'b'], false));
      vi.advanceTimersByTime(1_000);
    }

    expect(recallMarketplacePages(keys[0])).toBeNull();
    for (const key of keys.slice(1)) expect(recallMarketplacePages(key)).not.toBeNull();
    expect(Object.keys(window.sessionStorage).filter((key) => key.startsWith('marketplace-pages:')))
      .toHaveLength(MARKETPLACE_PAGES_MEMORY_MAX_LISTINGS);
  });

  it('drops listings too old to give back whenever it keeps another', () => {
    vi.useFakeTimers();
    vi.setSystemTime(performance.timeOrigin + 60_000);
    const old = buildMarketplacePagesKey('all/all//recent/old', null);
    rememberMarketplacePages(old, 1, pages(['a', 'b'], false));

    vi.advanceTimersByTime(MARKETPLACE_PAGES_MEMORY_TTL_MS + 1);
    rememberMarketplacePages(KEY, 1, pages(['a', 'b'], false));

    expect(window.sessionStorage.getItem(old)).toBeNull();
  });

  it('keeps no listing longer than its cap', () => {
    const long = Array.from({ length: MARKETPLACE_PAGES_MEMORY_MAX_ITEMS + 1 }, (_, index) => `r${index}`);
    rememberMarketplacePages(KEY, 4, pages(long.slice(0, 16), true));

    rememberMarketplacePages(KEY, 4, pages(long, true));

    expect(recallMarketplacePages(KEY)).toBeNull();
    // The rule the list asks for its next page by: only while the listing with it is kept.
    expect(fitsMarketplacePagesMemory(MARKETPLACE_PAGES_MEMORY_MAX_ITEMS)).toBe(true);
    expect(fitsMarketplacePagesMemory(MARKETPLACE_PAGES_MEMORY_MAX_ITEMS + 1)).toBe(false);
  });

  // Review of #888: pages land as the reader scrolls, and each one parsed every listing the tab kept
  // to make room. A listing kept already is written over in place and reads none of the others.
  it('writes a listing kept already over in place, reading none of the others', () => {
    vi.useFakeTimers();
    vi.setSystemTime(performance.timeOrigin + 60_000);
    const others = Array.from({ length: MARKETPLACE_PAGES_MEMORY_MAX_LISTINGS - 1 }, (_, index) => (
      buildMarketplacePagesKey(`all/all//recent/${index}`, null)
    ));
    for (const key of [...others, KEY]) {
      rememberMarketplacePages(key, 1, pages(['a', 'b'], true));
      vi.advanceTimersByTime(1_000);
    }

    const parse = vi.spyOn(JSON, 'parse');
    try {
      rememberMarketplacePages(KEY, 1, pages(['a', 'b', 'c'], true));
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(ids(recallMarketplacePages(KEY))).toEqual(['a', 'b', 'c']);
    for (const key of others) expect(recallMarketplacePages(key)).not.toBeNull();

    // A listing new to the tab still makes room, the one kept longest ago going first.
    vi.advanceTimersByTime(1_000);
    rememberMarketplacePages(buildMarketplacePagesKey('paid/all//recent/', null), 1, pages(['a', 'b'], false));
    expect(recallMarketplacePages(others[0])).toBeNull();
  });
});

// Review of #837: Back to a listing whose filters a phone had left open drew them folded, the page
// above the grid a panel shorter, and the reader landed that far down from their recipe.
describe("a Marketplace listing's filters, left open", () => {
  const LISTING = 'all\u0000all\u0000\u0000recent\u0000';
  const OTHER = 'paid\u0000all\u0000\u0000recent\u0000';

  it('are given back open for that listing alone, and folded keeps nothing', () => {
    expect(recallMarketplaceFiltersOpen(LISTING)).toBe(false);

    rememberMarketplaceFiltersOpen(LISTING, true);
    expect(recallMarketplaceFiltersOpen(LISTING)).toBe(true);
    expect(recallMarketplaceFiltersOpen(OTHER)).toBe(false);

    // Folding another listing's leaves this one's as it is.
    rememberMarketplaceFiltersOpen(OTHER, false);
    expect(recallMarketplaceFiltersOpen(LISTING)).toBe(true);

    rememberMarketplaceFiltersOpen(LISTING, false);
    expect(recallMarketplaceFiltersOpen(LISTING)).toBe(false);
  });

  it('are never given back from before this document loaded, nor ten minutes on', () => {
    window.sessionStorage.setItem('marketplace-filters-open', JSON.stringify({ listingKey: LISTING, savedAt: performance.timeOrigin - 1 }));
    expect(recallMarketplaceFiltersOpen(LISTING)).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(performance.timeOrigin + 60_000);
    rememberMarketplaceFiltersOpen(LISTING, true);
    vi.setSystemTime(Date.now() + MARKETPLACE_PAGES_MEMORY_TTL_MS + 1);
    expect(recallMarketplaceFiltersOpen(LISTING)).toBe(false);
  });
});
