import { describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createSeedanceAssetRouteHandlers,
  getSeedanceAssetRouteResponse,
  postSeedanceAssetRouteResponse,
} from '@/lib/seedance-asset-route-adapter-service';

describe('Seedance asset route adapter service', () => {
  it('rejects unauthenticated asset creation before requiring provider credentials or parsing JSON', async () => {
    const requireKieApiKey = vi.fn();
    const createServiceClient = vi.fn();
    const createSeedanceAssetForRoute = vi.fn();

    const response = await postSeedanceAssetRouteResponse({
      request: new Request('http://localhost/api/seedance-assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'seedance-auth-1',
        },
        body: '{',
      }),
      dependencies: {
        authenticateRequest: vi.fn(async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })),
        createSeedanceAssetForRoute,
        createServiceClient,
        requireKieApiKey,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('seedance-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(requireKieApiKey).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createSeedanceAssetForRoute).not.toHaveBeenCalled();
  });

  it('rejects missing provider credentials before parsing JSON or creating a service client', async () => {
    const createServiceClient = vi.fn();
    const createSeedanceAssetForRoute = vi.fn();

    const response = await postSeedanceAssetRouteResponse({
      request: new Request('http://localhost/api/seedance-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: {} as SupabaseClient,
        })),
        createSeedanceAssetForRoute,
        createServiceClient,
        requireKieApiKey: vi.fn(() => NextResponse.json({ error: 'KIE API key missing' }, { status: 500 })),
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'KIE API key missing' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createSeedanceAssetForRoute).not.toHaveBeenCalled();
  });

  it('keeps unexpected creation failures generic while logging the detail', async () => {
    const logError = vi.fn();

    const response = await postSeedanceAssetRouteResponse({
      request: new Request('http://localhost/api/seedance-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'uploads/user-1/reference.mp4', assetType: 'Video' }),
      }),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: {} as SupabaseClient,
        })),
        createSeedanceAssetForRoute: vi.fn(async () => {
          throw new Error('provider credential rejected: key kie_live_1234');
        }),
        createServiceClient: vi.fn(() => ({ kind: 'admin' } as unknown as SupabaseClient)),
        logError,
        requireKieApiKey: vi.fn(() => 'test-key'),
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to create Seedance asset' });
    expect(logError).toHaveBeenCalledWith(
      'Seedance asset creation error:',
      expect.objectContaining({ message: expect.stringContaining('provider credential rejected') }),
    );
  });

  it('creates Seedance assets through the service with private no-store headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createSeedanceAssetForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        assetId: 'asset-123',
        assetType: 'Video' as const,
        status: 'processing' as const,
        rawStatus: 'processing',
        error: null,
        sourceUrl: 'https://signed.example.com/reference.mp4',
        lastCheckedAt: '2026-06-23T12:30:00.000Z',
      },
    }));

    const response = await postSeedanceAssetRouteResponse({
      request: new Request('http://localhost/api/seedance-assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'seedance-create-1',
        },
        body: JSON.stringify({ url: 'uploads/user-1/reference.mp4', assetType: 'Video' }),
      }),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: {} as SupabaseClient,
        })),
        createSeedanceAssetForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        requireKieApiKey: vi.fn(() => 'test-key'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('seedance-create-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      assetId: 'asset-123',
    });
    expect(createSeedanceAssetForRoute).toHaveBeenCalledWith({
      adminSupabase,
      apiKey: 'test-key',
      body: { url: 'uploads/user-1/reference.mp4', assetType: 'Video' },
      userId: 'user-1',
    });
  });

  it('loads Seedance asset status with trimmed asset ids after auth and API-key checks', async () => {
    const getSeedanceAssetForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        assetId: 'asset-456',
        assetType: 'Audio' as const,
        status: 'active' as const,
        rawStatus: 'Success',
        error: null,
        sourceUrl: 'https://signed.example.com/ref.wav',
        lastCheckedAt: '2026-06-23T12:31:00.000Z',
      },
    }));

    const response = await getSeedanceAssetRouteResponse({
      request: new Request('http://localhost/api/seedance-assets?assetId=%20asset-456%20'),
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: {} as SupabaseClient,
        })),
        getSeedanceAssetForRoute,
        requireKieApiKey: vi.fn(() => 'test-key'),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      assetId: 'asset-456',
    });
    expect(getSeedanceAssetForRoute).toHaveBeenCalledWith({
      apiKey: 'test-key',
      assetId: 'asset-456',
    });
  });

  it('creates route handlers that forward GET and POST Seedance asset requests through the adapter', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createSeedanceAssetForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        assetId: 'asset-created',
        assetType: 'Video' as const,
        status: 'processing' as const,
        rawStatus: 'processing',
        error: null,
        sourceUrl: 'https://signed.example.com/reference.mp4',
        lastCheckedAt: '2026-06-23T12:35:00.000Z',
      },
    }));
    const getSeedanceAssetForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        assetId: 'asset-loaded',
        assetType: 'Video' as const,
        status: 'active' as const,
        rawStatus: 'Success',
        error: null,
        sourceUrl: 'https://signed.example.com/reference.mp4',
        lastCheckedAt: '2026-06-23T12:36:00.000Z',
      },
    }));
    const { GET, POST } = createSeedanceAssetRouteHandlers({
      dependencies: {
        authenticateRequest: vi.fn(async () => ({
          userId: 'user-1',
          supabase: {} as SupabaseClient,
        })),
        createSeedanceAssetForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        getSeedanceAssetForRoute,
        requireKieApiKey: vi.fn(() => 'test-key'),
      },
    });

    const getResponse = await GET(new Request(
      'http://localhost/api/seedance-assets?assetId=%20asset-loaded%20',
      { headers: { 'x-request-id': 'seedance-factory-get-1' } },
    ));
    const postResponse = await POST(new Request('http://localhost/api/seedance-assets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'seedance-factory-post-1',
      },
      body: JSON.stringify({ url: 'uploads/user-1/reference.mp4', assetType: 'Video' }),
    }));

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getResponse.headers.get('x-request-id')).toBe('seedance-factory-get-1');
    expect(postResponse.status).toBe(200);
    expect(postResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(postResponse.headers.get('x-request-id')).toBe('seedance-factory-post-1');
    await expect(getResponse.json()).resolves.toMatchObject({ assetId: 'asset-loaded' });
    await expect(postResponse.json()).resolves.toMatchObject({ assetId: 'asset-created' });
    expect(getSeedanceAssetForRoute).toHaveBeenCalledWith({
      apiKey: 'test-key',
      assetId: 'asset-loaded',
    });
    expect(createSeedanceAssetForRoute).toHaveBeenCalledWith({
      adminSupabase,
      apiKey: 'test-key',
      body: { url: 'uploads/user-1/reference.mp4', assetType: 'Video' },
      userId: 'user-1',
    });
  });
});
