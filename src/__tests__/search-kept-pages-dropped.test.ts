import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEARCH_KEPT_PAGES_KEY, keepSearchPage } from '@/lib/search-kept-pages';

// What search kept for Back is dropped where the viewer changes what a search
// would show them (review of #788): a block or a report, a change to or the
// delete of their own post, a recipe taken. Each through the shared client
// every surface calls.

vi.mock('@/components/feedback-state', () => ({
  pushToast: vi.fn(),
  requestConfirmation: vi.fn(async () => true),
}));
vi.mock('@/lib/moderation-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/moderation-client')>()),
  blockCreator: vi.fn(async () => undefined),
  reportPostContent: vi.fn(async () => undefined),
  reportCreator: vi.fn(async () => undefined),
}));
vi.mock('@/lib/product-analytics', () => ({ trackProductEvent: vi.fn() }));

const kept = () => window.sessionStorage.getItem(SEARCH_KEPT_PAGES_KEY);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('kept searches are dropped when what a search shows changes', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    keepSearchPage('/search?q=lantern', { n: 1 }, 0, 'account-a');
    expect(kept()).not.toBeNull();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('at a block, and at a report of a post or a creator', async () => {
    const actions = await import('@/lib/feed-safety-actions');
    await actions.blockCreatorAfterConfirmation({ userId: 'creator-1', creatorName: 'Luna', accessToken: 'token' });
    expect(kept()).toBeNull();
    keepSearchPage('/search?q=lantern', { n: 1 }, 0, 'account-a');
    await actions.reportPostAfterConfirmation({ postId: 'post-1', accessToken: 'token', surface: 'post-page' });
    expect(kept()).toBeNull();
    keepSearchPage('/search?q=lantern', { n: 1 }, 0, 'account-a');
    await actions.reportCreatorAfterConfirmation({ userId: 'creator-1', accessToken: 'token', surface: 'post-page' });
    expect(kept()).toBeNull();
  });

  it('at a change to the viewer’s own post, and its delete; not at a refusal', async () => {
    const lifecycle = await import('@/lib/post-lifecycle-client');
    await expect(lifecycle.requestPostArchive({ postId: 'post-1', accessToken: 'token', fetchImpl: async () => json({ error: 'No' }, 403) })).rejects.toThrow();
    expect(kept()).not.toBeNull();
    await lifecycle.requestPostArchive({ postId: 'post-1', accessToken: 'token', fetchImpl: async () => json({ success: true }) });
    expect(kept()).toBeNull();
    keepSearchPage('/search?q=lantern', { n: 1 }, 0, 'account-a');
    await lifecycle.requestPostDelete({ postId: 'post-1', accessToken: 'token', fetchImpl: async () => json({ success: true }) });
    expect(kept()).toBeNull();
  });

  it('at a free recipe taken', async () => {
    vi.stubGlobal('fetch', async () => json({ ok: true }));
    const { claimFreeRecipe } = await import('@/lib/free-recipe-claim-client');
    await claimFreeRecipe('post-1', 'token');
    expect(kept()).toBeNull();
  });
});
