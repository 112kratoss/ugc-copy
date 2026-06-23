import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getMarketplaceSalesExportRouteResponse } from '@/lib/marketplace-sales-export-route-adapter-service';
import type { MarketplaceSalesExportRouteResult } from '@/lib/marketplace-sales-export-service';

function createUserClient(userId: string | null = 'seller-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('marketplace sales export route adapter service', () => {
  it('rejects unauthenticated export requests before privileged clients or export work', async () => {
    const createServiceClient = vi.fn();
    const exportMarketplaceSalesForRoute = vi.fn();

    const response = await getMarketplaceSalesExportRouteResponse({
      request: new Request('http://localhost/api/marketplace/sales/export', {
        headers: { 'x-request-id': 'sales-export-auth-1' },
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        exportMarketplaceSalesForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('sales-export-auth-1');
    await expect(response.text()).resolves.toBe('Unauthorized');
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(exportMarketplaceSalesForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid export requests and returns CSV download headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const exportMarketplaceSalesForRoute = vi.fn(
      async (): Promise<MarketplaceSalesExportRouteResult> => ({
        ok: true,
        csv: 'asset_title,buyer_user_id\nListing,buyer-1',
      }),
    );

    const response = await getMarketplaceSalesExportRouteResponse({
      request: new Request('http://localhost/api/marketplace/sales/export', {
        headers: { 'x-request-id': 'sales-export-success-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('seller-1'),
        exportMarketplaceSalesForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="marketplace-sales.csv"');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('sales-export-success-1');
    await expect(response.text()).resolves.toBe('asset_title,buyer_user_id\nListing,buyer-1');
    expect(exportMarketplaceSalesForRoute).toHaveBeenCalledWith({
      adminSupabase,
      sellerUserId: 'seller-1',
    });
  });

  it('maps export service failures to private text responses', async () => {
    const response = await getMarketplaceSalesExportRouteResponse({
      request: new Request('http://localhost/api/marketplace/sales/export', {
        headers: { 'x-request-id': 'sales-export-failed-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('seller-1'),
        exportMarketplaceSalesForRoute: vi.fn(
          async (): Promise<MarketplaceSalesExportRouteResult> => ({
            ok: false,
            status: 500,
            body: 'Failed to load sales',
          }),
        ),
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('sales-export-failed-1');
    await expect(response.text()).resolves.toBe('Failed to load sales');
  });
});
