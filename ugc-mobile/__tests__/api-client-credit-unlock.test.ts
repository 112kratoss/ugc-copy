import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from '../lib/api-client';

/**
 * S3 (recipe audit 2026-10-27, H4): a credits unlock charged whatever the
 * price was at the tap. The client now sends the price the buyer confirmed,
 * and a 409 `RESOURCE_PRICE_CHANGED` reaches the caller with the price now.
 */
function client(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return createApiClient({
    baseUrl: 'https://magicbooklet.test',
    getAccessToken: async () => 'token-1',
    fetcher: fetcher as unknown as typeof fetch,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('the credits unlock', () => {
  it('sends the price the buyer confirmed as JSON', async () => {
    const fetcher = vi.fn(async () => json({ success: true, entitlement: 'post_resource_unlock', credits: 100 }));
    await client(fetcher).unlockBundleWithCredits('post-1', 900);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/posts/post-1/resource-bundle/unlock-with-credits');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ expectedPriceCredits: 900 });
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('sends no body without a confirmed price, as builds before the check did', async () => {
    const fetcher = vi.fn(async () => json({ success: true }));
    await client(fetcher).unlockBundleWithCredits('post-1');

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('hands the refusal over with its code and the price now', async () => {
    const body = {
      success: false,
      code: 'RESOURCE_PRICE_CHANGED',
      error: 'The price changed to 1200 credits.',
      priceCredits: 1200,
    };
    const fetcher = vi.fn(async () => json(body, 409));
    const error = await client(fetcher).unlockBundleWithCredits('post-1', 900).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    // What `readPriceChangedRefusal` (lib/use-bundle-unlock.ts) reads.
    expect(error).toMatchObject({ status: 409, code: 'RESOURCE_PRICE_CHANGED', details: body });
  });
});

// B-F7: the Details page asks a post with no listing for its own recipe, which
// answers a buyer after the creator unlisted or retired it.
describe("the post's own recipe read", () => {
  it('goes straight to the post when there is no recipe id to ask by', async () => {
    const fetcher = vi.fn(async () => json({ success: true, bundle: { id: 'asset-9', viewerCanAccess: true } }));
    const answer = await client(fetcher).getMarketplaceResourceDetail(null, { postId: 'post-1' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/posts/post-1/resource-bundle');
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(answer.bundle).toMatchObject({ id: 'asset-9', viewerCanAccess: true });
  });

  it('still asks by the recipe id first when there is one', async () => {
    const fetcher = vi.fn(async () => json({ success: true, bundle: { id: 'asset-1' } }));
    await client(fetcher).getMarketplaceResourceDetail('asset-1', { postId: 'post-1' });

    const [url] = fetcher.mock.calls[0] as unknown as [string];
    expect(new URL(url).pathname).toBe('/api/marketplace/resources/asset-1');
  });
});

