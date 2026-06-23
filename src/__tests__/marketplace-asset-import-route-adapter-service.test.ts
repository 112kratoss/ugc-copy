import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { postMarketplaceAssetImportRouteResponse } from '@/lib/marketplace-asset-import-route-adapter-service';
import type { MarketplaceAssetImportResult } from '@/lib/marketplace-asset-import-service';

function createContext(assetId = 'asset-1') {
  return {
    params: Promise.resolve({ assetId }),
  };
}

function createUserClient(userId: string | null = 'buyer-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('marketplace asset import route adapter service', () => {
  it('rejects unauthenticated imports before privileged work', async () => {
    const createServiceClient = vi.fn();
    const importMarketplaceWorkflowAssetForRoute = vi.fn();

    const response = await postMarketplaceAssetImportRouteResponse({
      request: new Request('http://localhost/api/marketplace/assets/asset-1/import', {
        method: 'POST',
        headers: { 'x-request-id': 'asset-import-auth-1' },
      }),
      context: createContext(),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        importMarketplaceWorkflowAssetForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('asset-import-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(importMarketplaceWorkflowAssetForRoute).not.toHaveBeenCalled();
  });

  it('maps service rate-limit results with standard backend headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient('buyer-1');
    const importMarketplaceWorkflowAssetForRoute = vi.fn(async (): Promise<MarketplaceAssetImportResult> => ({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 43,
      limit: 30,
      remaining: 0,
      resetAt: '2026-06-23T08:30:00.000Z',
      body: {
        error: 'Too many marketplace import requests.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: 43,
        limit: 30,
        resetAt: '2026-06-23T08:30:00.000Z',
      },
    }));

    const response = await postMarketplaceAssetImportRouteResponse({
      request: new Request('http://localhost/api/marketplace/assets/asset-1/import', {
        method: 'POST',
        headers: { 'x-request-id': 'asset-import-limit-1' },
      }),
      context: createContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => userSupabase,
        importMarketplaceWorkflowAssetForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('43');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('asset-import-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 43,
      limit: 30,
    });
    expect(importMarketplaceWorkflowAssetForRoute).toHaveBeenCalledWith({
      adminSupabase,
      assetId: 'asset-1',
      userId: 'buyer-1',
      userSupabase,
    });
  });

  it('delegates successful imports with user and admin clients', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient('buyer-1');
    const importMarketplaceWorkflowAssetForRoute = vi.fn(async (): Promise<MarketplaceAssetImportResult> => ({
      ok: true,
      body: {
        success: true,
        redirectTo: '/create-workflow',
        canvas: {
          id: 'canvas-1',
          title: 'Copy of Launch Workflow',
          graph: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
          revision: 1,
          created_at: '2026-06-23T08:00:00.000Z',
          updated_at: '2026-06-23T08:00:00.000Z',
          status: 'draft',
          published_at: null,
        },
      },
    }));

    const response = await postMarketplaceAssetImportRouteResponse({
      request: new Request('http://localhost/api/marketplace/assets/asset-1/import', {
        method: 'POST',
        headers: { 'x-request-id': 'asset-import-success-1' },
      }),
      context: createContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => userSupabase,
        importMarketplaceWorkflowAssetForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('asset-import-success-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      redirectTo: '/create-workflow',
      canvas: { id: 'canvas-1', status: 'draft' },
    });
    expect(importMarketplaceWorkflowAssetForRoute).toHaveBeenCalledWith({
      adminSupabase,
      assetId: 'asset-1',
      userId: 'buyer-1',
      userSupabase,
    });
  });
});
