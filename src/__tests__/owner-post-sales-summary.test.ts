import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server-helpers', () => ({ createServiceClient: vi.fn() }));

import { parseOwnerPostSalesSummary } from '@/lib/owner-post-sales-summary';

// Decision 6 (2026-10-17): the seller totals count paid sales and free unlocks
// apart, both from get_owner_post_sales_summary.
describe('owner post sales summary', () => {
  it('reads paid sales and free unlocks apart', () => {
    expect(parseOwnerPostSalesSummary({
      salesCount: 2,
      freeUnlockCount: 20,
      earningsUsdCents: 1530,
      listingCount: 16,
    })).toEqual({ salesCount: 2, freeUnlockCount: 20, earningsUsdCents: 1530, listingCount: 16 });
  });

  it('reads bigint text from the RPC as numbers', () => {
    expect(parseOwnerPostSalesSummary({ salesCount: '3', freeUnlockCount: '7', earningsUsdCents: '90', listingCount: 1 }))
      .toMatchObject({ salesCount: 3, freeUnlockCount: 7, earningsUsdCents: 90 });
  });

  it('counts a missing or unreadable free unlock total as none', () => {
    expect(parseOwnerPostSalesSummary({ salesCount: 4, earningsUsdCents: 0, listingCount: 1 }).freeUnlockCount).toBe(0);
    expect(parseOwnerPostSalesSummary({ freeUnlockCount: -5 }).freeUnlockCount).toBe(0);
    expect(parseOwnerPostSalesSummary(null).freeUnlockCount).toBe(0);
  });
});
