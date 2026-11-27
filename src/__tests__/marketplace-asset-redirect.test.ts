import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((target: string) => { throw new Error(`NEXT_REDIRECT:${target}`); }),
  permanentRedirect: vi.fn((target: string) => { throw new Error(`NEXT_REDIRECT:${target}`); }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  resolve: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  permanentRedirect: mocks.permanentRedirect,
  notFound: mocks.notFound,
}));
vi.mock('@/lib/post-resource-bundles-server', () => ({
  resolvePostIdForResourceIdentifier: mocks.resolve,
}));

import MarketplaceAssetPage from '@/app/marketplace/[assetId]/page';

// An old resource address always names the same post, so it moves there for good (308), not for
// now (307): a crawler and a browser keep the post's address (audit 2026-11-27).
describe('/marketplace/[assetId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects permanently to the post that holds the resource', async () => {
    mocks.resolve.mockResolvedValueOnce('post-1');
    await expect(MarketplaceAssetPage({ params: Promise.resolve({ assetId: 'asset-1' }) })).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.permanentRedirect).toHaveBeenCalledTimes(1);
    expect(mocks.permanentRedirect.mock.calls[0][0]).toMatch(/^\/showcase\/post-1\?/);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('answers not-found for an address that names no resource', async () => {
    mocks.resolve.mockResolvedValueOnce(null);
    await expect(MarketplaceAssetPage({ params: Promise.resolve({ assetId: 'nothing' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.permanentRedirect).not.toHaveBeenCalled();
  });
});
