import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { refreshUnlockedBundleCaches } from '@/lib/unlock-cache';

describe('refreshUnlockedBundleCaches', () => {
  it('invalidates every cache that describes the purchase, most specific first', async () => {
    const invalidateQueries = vi.fn(async () => undefined) as unknown as QueryClient['invalidateQueries'];

    await refreshUnlockedBundleCaches({ invalidateQueries }, { postId: 'post-123', resourceId: 'asset-123' });

    const calls = (invalidateQueries as unknown as { mock: { calls: Array<[{ queryKey?: unknown }]> } }).mock.calls;
    expect(calls.map(([input]) => input.queryKey)).toEqual([
      ['post-resource-bundle', 'post-123', 'asset-123'],
      ['marketplace-resource', 'asset-123'],
      ['marketplace-resources'],
      ['showcase-feed'],
      ['showcase-post', 'post-123'],
      ['immersive-preview-source'],
    ]);
  });
});
