import 'server-only';

import { createServiceClient } from '@/lib/server-helpers';

export interface OwnerPostSalesSummary {
  earningsUsdCents: number;
  listingCount: number;
  /** Paid unlocks. A free unlock is not a sale (decision 6, 2026-10-17). */
  salesCount: number;
  freeUnlockCount: number;
}

export async function getOwnerPostSalesSummary(userId: string): Promise<OwnerPostSalesSummary> {
  const { data, error } = await createServiceClient().rpc('get_owner_post_sales_summary', {
    p_owner_id: userId,
  });

  if (error) throw error;

  return parseOwnerPostSalesSummary(data);
}

/** The RPC's jsonb as the summary the app draws; anything missing counts as 0. */
export function parseOwnerPostSalesSummary(data: unknown): OwnerPostSalesSummary {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};

  return {
    earningsUsdCents: nonNegativeInteger(record.earningsUsdCents),
    listingCount: nonNegativeInteger(record.listingCount),
    salesCount: nonNegativeInteger(record.salesCount),
    freeUnlockCount: nonNegativeInteger(record.freeUnlockCount),
  };
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}
