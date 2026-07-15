import 'server-only';

import { createServiceClient } from '@/lib/server-helpers';

export interface OwnerPostSalesSummary {
  earningsUsdCents: number;
  listingCount: number;
  salesCount: number;
}

export async function getOwnerPostSalesSummary(userId: string): Promise<OwnerPostSalesSummary> {
  const { data, error } = await createServiceClient().rpc('get_owner_post_sales_summary', {
    p_owner_id: userId,
  });

  if (error) throw error;

  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};

  return {
    earningsUsdCents: nonNegativeInteger(record.earningsUsdCents),
    listingCount: nonNegativeInteger(record.listingCount),
    salesCount: nonNegativeInteger(record.salesCount),
  };
}

function nonNegativeInteger(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}
